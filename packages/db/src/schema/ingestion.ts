import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, inList, tstz } from './_shared.js';
import { merchants } from './merchants.js';
import { products } from './catalog.js';

export const INGESTION_JOB_STATUSES = ['queued', 'running', 'completed', 'failed'] as const;
export type IngestionJobStatus = (typeof INGESTION_JOB_STATUSES)[number];

/**
 * Not in context §6, but T1.11 requires it: the worker creates a row here and the
 * dashboard polls it for live progress (T1.24).
 */
export const ingestionJobs = pgTable(
  'ingestion_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    s3Key: text('s3_key').notNull(),
    /** simple | variant — decides which CSV template validator runs. */
    template: text('template').notNull(),
    status: text('status').$type<IngestionJobStatus>().default('queued').notNull(),
    rowsTotal: integer('rows_total').default(0).notNull(),
    rowsImported: integer('rows_imported').default(0).notNull(),
    rowsFailed: integer('rows_failed').default(0).notNull(),
    productsCreated: integer('products_created').default(0).notNull(),
    productsUpdated: integer('products_updated').default(0).notNull(),
    variantsUpserted: integer('variants_upserted').default(0).notNull(),
    /** Capped at MAX_STORED_INGESTION_ERRORS; the full set goes to the error CSV. */
    errors: jsonb('errors').$type<{ row: number; column?: string; message: string }[]>(),
    errorCsvKey: text('error_csv_key'),
    /** Set when the whole file was rejected, e.g. a header mismatch. */
    rejectionReason: text('rejection_reason'),
    startedAt: tstz('started_at'),
    completedAt: tstz('completed_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('ingestion_jobs_merchant_created_idx').on(t.merchantId, t.createdAt),
    check('ingestion_jobs_status_check', sql`${t.status} IN (${inList(INGESTION_JOB_STATUSES)})`),
    check('ingestion_jobs_template_check', sql`${t.template} IN ('simple', 'variant')`),
  ],
);

/**
 * S5.4 — one row per stage transition, per product.
 *
 * Without this, "why is my product not showing up" is unanswerable, and it will be the most
 * common support question a merchant asks. `searchable_units.embedding_status` says where a
 * product ended up but not how it got there or what went wrong on the way, and by the time
 * anyone looks the failing message has long since left the queue.
 *
 * Deliberately append-only and cheap to write: every worker adds a row, nothing updates one.
 * Retention is a later concern — a catalogue of 10k products generates a few rows each, not
 * a firehose.
 */
export const productPipelineEvents = pgTable(
  'product_pipeline_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    /** ingestion | enrichment | embedding */
    stage: text('stage').notNull(),
    /** started | succeeded | failed | skipped */
    status: text('status').notNull(),
    /**
     * What happened, in words a merchant can act on. "Image at position 2 returned 404" is
     * useful; "EMBEDDING_FAILED" is not, and the code is already in `stage`/`status`.
     */
    message: text('message'),
    durationMs: integer('duration_ms'),
    createdAt: createdAt(),
  },
  (t) => [index('product_pipeline_events_product_idx').on(t.productId, t.createdAt)],
);
