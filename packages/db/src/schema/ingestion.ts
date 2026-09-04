import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, inList, tstz } from './_shared.js';
import { merchants } from './merchants.js';

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
