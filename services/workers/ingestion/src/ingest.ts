import {
  AppError,
  CatalogRowCollector,
  MAX_STORED_INGESTION_ERRORS,
  type Clock,
  type CsvRowError,
  type CsvTemplate,
  type EnrichmentMessage,
  type IngestionMessage,
  type Mailer,
  type ObjectStore,
  type ParsedProduct,
  type Queue,
} from '@catalograil/core';
import { ingestionJobs, merchants, type Database } from '@catalograil/db';
import { eq } from 'drizzle-orm';
import { buildErrorCsv, errorCsvKey } from './error-csv.js';
import { renderCompletionEmail, renderRejectionEmail } from './email.js';
import { CsvHeaderRejection, streamCsvRows } from './stream.js';
import { upsertProduct } from './upsert.js';

/**
 * T1.11 — the ingestion worker.
 *
 * S3 ObjectCreated → SQS `ingestion` → here. Streams the file, validates row by row,
 * collapses variant rows into products, and writes each product in its own transaction.
 *
 * Two properties this is built around:
 *
 *   - **Partial success is the normal case.** A file with ten bad rows imports the other
 *     490 and reports the ten by line number. Only a header mismatch takes the whole file
 *     down, because then nothing can be trusted to mean what it says.
 *   - **Re-running is safe.** SQS redelivers, and merchants re-upload the same file after
 *     fixing a row. Products match on `(merchant_id, external_ref)` so a repeat updates
 *     rather than duplicates, and a job already marked completed short-circuits.
 */

export interface IngestionDeps {
  readonly db: Database;
  readonly objectStore: ObjectStore;
  readonly enrichmentQueue: Queue<EnrichmentMessage>;
  readonly mailer: Mailer;
  readonly clock: Clock;
  /** Where the downloadable error report is written. */
  readonly exportsPrefix?: string;
}

export interface IngestionOutcome {
  readonly jobId: string;
  readonly status: 'completed' | 'failed';
  readonly rowsTotal: number;
  readonly rowsImported: number;
  readonly rowsFailed: number;
  readonly productsCreated: number;
  readonly productsUpdated: number;
  readonly variantsUpserted: number;
  readonly errorCount: number;
  readonly errors: readonly CsvRowError[];
  readonly errorCsvKey?: string;
  readonly rejectionReason?: string;
  /** True when a redelivered message hit an already-completed job. */
  readonly skipped?: boolean;
}

export async function runIngestion(
  message: IngestionMessage,
  deps: IngestionDeps,
): Promise<IngestionOutcome> {
  const { db, clock } = deps;

  const job = await loadJob(db, message.jobId);

  /**
   * The job row is created by the upload endpoint, not here, because the template is only
   * known at the point the merchant asked for the upload URL — the S3 key does not carry
   * it. T1.11 lists row creation as the worker's first step; this is the same row, created
   * one hop earlier so its `template` is trustworthy rather than guessed from the file.
   */
  if (!job) {
    throw new AppError('INGESTION_FAILED', `No ingestion job ${message.jobId}.`, {
      details: { jobId: message.jobId },
      retryable: false,
    });
  }

  // SQS is at-least-once. A redelivered message must not re-import a finished job.
  if (job.status === 'completed' || job.status === 'failed') {
    return {
      jobId: job.id,
      status: job.status,
      rowsTotal: job.rowsTotal,
      rowsImported: job.rowsImported,
      rowsFailed: job.rowsFailed,
      productsCreated: job.productsCreated,
      productsUpdated: job.productsUpdated,
      variantsUpserted: job.variantsUpserted,
      errorCount: job.rowsFailed,
      errors: job.errors ?? [],
      ...(job.errorCsvKey ? { errorCsvKey: job.errorCsvKey } : {}),
      ...(job.rejectionReason ? { rejectionReason: job.rejectionReason } : {}),
      skipped: true,
    };
  }

  await db
    .update(ingestionJobs)
    .set({ status: 'running', startedAt: clock.now() })
    .where(eq(ingestionJobs.id, job.id));

  const template = job.template as CsvTemplate;
  const collector = new CatalogRowCollector(template, { maxErrors: MAX_STORED_INGESTION_ERRORS });

  // ── Read and validate ─────────────────────────────────────────────────────────
  try {
    const source = await deps.objectStore.readStream(message.s3Key);
    for await (const { record, rowNumber } of streamCsvRows(source, template)) {
      collector.addRow(record, rowNumber);
    }
  } catch (err) {
    if (err instanceof CsvHeaderRejection) {
      return failJob(job.id, message, deps, err.rejection.message);
    }
    throw AppError.from(err);
  }

  if (collector.productLimitExceeded) {
    return failJob(
      job.id,
      message,
      deps,
      'The file contains more products than a single upload can carry. Split it into smaller files.',
    );
  }

  // ── Write ─────────────────────────────────────────────────────────────────────
  const write = await writeProducts(db, message.merchantId, collector.products);

  // Enrichment is enqueued after the writes commit, so a consumer can never pick up a
  // product id that is not yet visible to another connection.
  await deps.enrichmentQueue.sendBatch(
    write.productIds.map((productId) => ({ productId, merchantId: message.merchantId })),
  );

  // ── Report ────────────────────────────────────────────────────────────────────
  const errors = [...collector.errors, ...write.errors];
  const errorCount = collector.errorCount + write.errors.length;
  const rowsFailed = collector.rowsTotal - collector.rowsValid + write.rowsLost;

  let storedErrorCsvKey: string | undefined;
  if (errors.length > 0) {
    storedErrorCsvKey = errorCsvKey(message.merchantId, job.id, deps.exportsPrefix);
    await deps.objectStore.put(storedErrorCsvKey, buildErrorCsv(errors), {
      contentType: 'text/csv; charset=utf-8',
    });
  }

  const outcome: IngestionOutcome = {
    jobId: job.id,
    status: 'completed',
    rowsTotal: collector.rowsTotal,
    rowsImported: collector.rowsValid - write.rowsLost,
    rowsFailed,
    productsCreated: write.created,
    productsUpdated: write.updated,
    variantsUpserted: write.variantsUpserted,
    errorCount,
    errors,
    ...(storedErrorCsvKey ? { errorCsvKey: storedErrorCsvKey } : {}),
  };

  await db
    .update(ingestionJobs)
    .set({
      status: 'completed',
      rowsTotal: outcome.rowsTotal,
      rowsImported: outcome.rowsImported,
      rowsFailed: outcome.rowsFailed,
      productsCreated: outcome.productsCreated,
      productsUpdated: outcome.productsUpdated,
      variantsUpserted: outcome.variantsUpserted,
      errors: errors.slice(0, MAX_STORED_INGESTION_ERRORS),
      errorCsvKey: storedErrorCsvKey ?? null,
      completedAt: clock.now(),
    })
    .where(eq(ingestionJobs.id, job.id));

  await notify(deps, message.merchantId, renderCompletionEmail(outcome), errors);

  return outcome;
}

// ─── Writing ──────────────────────────────────────────────────────────────────────

interface WriteSummary {
  created: number;
  updated: number;
  variantsUpserted: number;
  productIds: string[];
  errors: CsvRowError[];
  /** Rows belonging to products whose transaction failed. */
  rowsLost: number;
}

/**
 * One transaction per product, per T1.11.
 *
 * A product whose write fails is reported against the line it started on and the rest of
 * the file continues — one bad product must not cost a merchant the other 499.
 */
async function writeProducts(
  db: Database,
  merchantId: string,
  parsed: readonly ParsedProduct[],
): Promise<WriteSummary> {
  const summary: WriteSummary = {
    created: 0,
    updated: 0,
    variantsUpserted: 0,
    productIds: [],
    errors: [],
    rowsLost: 0,
  };

  for (const product of parsed) {
    try {
      const result = await db.transaction((tx) => upsertProduct(tx, merchantId, product));
      if (result.created) summary.created++;
      else summary.updated++;
      summary.variantsUpserted += result.variantsUpserted;
      summary.productIds.push(result.productId);
    } catch (err) {
      summary.errors.push({
        row: product.sourceRow,
        column: 'external_ref',
        message: `could not save "${product.externalRef}": ${(err as Error).message}`,
      });
      summary.rowsLost += product.variants.length;
    }
  }

  return summary;
}

// ─── Job bookkeeping ──────────────────────────────────────────────────────────────

async function loadJob(db: Database, jobId: string) {
  const rows = await db.select().from(ingestionJobs).where(eq(ingestionJobs.id, jobId)).limit(1);
  return rows[0];
}

async function failJob(
  jobId: string,
  message: IngestionMessage,
  deps: IngestionDeps,
  reason: string,
): Promise<IngestionOutcome> {
  await deps.db
    .update(ingestionJobs)
    .set({ status: 'failed', rejectionReason: reason, completedAt: deps.clock.now() })
    .where(eq(ingestionJobs.id, jobId));

  const outcome: IngestionOutcome = {
    jobId,
    status: 'failed',
    rowsTotal: 0,
    rowsImported: 0,
    rowsFailed: 0,
    productsCreated: 0,
    productsUpdated: 0,
    variantsUpserted: 0,
    errorCount: 0,
    errors: [],
    rejectionReason: reason,
  };

  await notify(deps, message.merchantId, renderRejectionEmail(reason), []);
  return outcome;
}

/**
 * Emailing the merchant must not fail the import. The catalogue is already written by this
 * point; an SES outage should not send the message back to the queue to be re-imported.
 */
async function notify(
  deps: IngestionDeps,
  merchantId: string,
  content: { subject: string; text: string },
  errors: readonly CsvRowError[],
): Promise<void> {
  try {
    const rows = await deps.db
      .select({ email: merchants.contactEmail })
      .from(merchants)
      .where(eq(merchants.id, merchantId))
      .limit(1);

    const to = rows[0]?.email;
    if (!to) return;

    await deps.mailer.send({
      to,
      subject: content.subject,
      text: content.text,
      ...(errors.length > 0
        ? {
            attachments: [
              {
                filename: 'import-errors.csv',
                content: buildErrorCsv(errors),
                contentType: 'text/csv; charset=utf-8',
              },
            ],
          }
        : {}),
    });
  } catch {
    // Swallowed deliberately — see the note above.
  }
}
