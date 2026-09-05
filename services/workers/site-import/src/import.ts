import {
  AppError,
  type Clock,
  type EnrichmentMessage,
  type Queue,
  type SiteImportMessage,
} from '@catalograil/core';
import { siteImportJobs, type Database } from '@catalograil/db';
import { IMPORT_SLOT, discover, toParsedProducts, type Fetcher } from '@catalograil/site-import';
import { eq, sql } from 'drizzle-orm';
import { upsertProduct } from '@catalograil/worker-ingestion';

/**
 * One slot of a website import.
 *
 * The whole feature is shaped around this function handling exactly fifty products and then
 * stopping. A merchant with four thousand products gets eighty invocations, each of which
 * either lands or is retried on its own; the alternative — one invocation that reads the
 * whole catalogue — is a Lambda that times out on precisely the merchants worth having, and
 * leaves behind a half-written catalogue nobody can tell apart from a finished one.
 *
 * Products land as `draft`, exactly as a CSV import does, and go through the same
 * enrichment and embedding path. Nothing a website says goes straight into search: the
 * merchant reviews it first, because it is their catalogue and this is a machine's reading
 * of a page that was written for people.
 */

const MAX_STORED_SKIPS = 50;

export interface SiteImportDeps {
  readonly db: Database;
  readonly fetch: Fetcher;
  readonly enrichmentQueue: Queue<EnrichmentMessage>;
  readonly siteImportQueue: Queue<SiteImportMessage>;
  readonly clock: Clock;
}

export interface SlotOutcome {
  readonly jobId: string;
  readonly offset: number;
  readonly method: string;
  readonly found: number;
  readonly created: number;
  readonly updated: number;
  readonly variantsUpserted: number;
  readonly done: boolean;
  readonly skipped?: boolean;
}

export async function runSlot(
  message: SiteImportMessage,
  deps: SiteImportDeps,
): Promise<SlotOutcome> {
  const { db, clock } = deps;

  const [job] = await db
    .select()
    .from(siteImportJobs)
    .where(eq(siteImportJobs.id, message.jobId))
    .limit(1);

  if (!job) {
    throw new AppError('NOT_FOUND', `No site import job ${message.jobId}.`, { retryable: false });
  }

  /**
   * SQS is at-least-once, so a finished job must not be re-imported — and neither must a
   * slot that has already been applied. `nextOffset` is the ledger: a redelivered message
   * for an offset already passed is a message whose work is already in the database.
   */
  if (job.status === 'completed' || job.status === 'failed' || job.nextOffset > message.offset) {
    return {
      jobId: job.id,
      offset: message.offset,
      method: job.method ?? 'none',
      found: 0,
      created: 0,
      updated: 0,
      variantsUpserted: 0,
      done: job.status !== 'running',
      skipped: true,
    };
  }

  if (message.offset === 0) {
    await db
      .update(siteImportJobs)
      .set({ status: 'running', startedAt: clock.now() })
      .where(eq(siteImportJobs.id, job.id));
  }

  const result = await discover(message.siteUrl, deps.fetch, {
    limit: IMPORT_SLOT,
    offset: message.offset,
  });

  /**
   * A first slot that found nothing is a site this cannot read, and saying so plainly is
   * the useful outcome. Silence would leave a merchant watching a progress bar for a job
   * that was never going to produce anything.
   */
  if (result.products.length === 0 && message.offset === 0) {
    await db
      .update(siteImportJobs)
      .set({
        status: 'failed',
        method: result.method,
        completedAt: clock.now(),
        skipped: result.skipped.slice(0, MAX_STORED_SKIPS),
        rejectionReason:
          'No machine-readable products were found. This works with Shopify stores and with ' +
          'any site whose product pages carry schema.org Product markup — the same data that ' +
          'puts a price in Google results. A CSV upload works for anything else.',
      })
      .where(eq(siteImportJobs.id, job.id));

    return {
      jobId: job.id,
      offset: message.offset,
      method: result.method,
      found: 0,
      created: 0,
      updated: 0,
      variantsUpserted: 0,
      done: true,
    };
  }

  // ── Write ─────────────────────────────────────────────────────────────────────
  const parsed = toParsedProducts(result.products);
  const productIds: string[] = [];
  let created = 0;
  let updated = 0;
  let variantsUpserted = 0;

  for (const product of parsed) {
    /**
     * One transaction per product, as the CSV path does. A product that lands with half its
     * variants is worse than one that failed and got counted — and one bad product in a
     * slot must not cost the other forty-nine.
     */
    try {
      const outcome = await db.transaction((tx) => upsertProduct(tx, message.merchantId, product));
      productIds.push(outcome.productId);
      if (outcome.created) created += 1;
      else updated += 1;
      variantsUpserted += outcome.variantsUpserted;
    } catch (err) {
      result.skipped.push({
        url: product.externalRef,
        reason: err instanceof Error ? err.message : 'could not be saved',
      });
    }
  }

  await deps.enrichmentQueue.sendBatch(
    productIds.map((productId) => ({ productId, merchantId: message.merchantId })),
  );

  const nextOffset = message.offset + result.products.length;
  const done = !result.truncated;

  /**
   * Counters accumulate in SQL rather than being read, added and written back.
   *
   * Two slots can be in flight after a redelivery, and a read-modify-write would lose one
   * of their contributions — leaving a merchant with a "products imported" number lower
   * than the products actually in their dashboard.
   */
  await db
    .update(siteImportJobs)
    .set({
      status: done ? 'completed' : 'running',
      method: result.method,
      nextOffset,
      slotsDone: sql`${siteImportJobs.slotsDone} + 1`,
      productsFound: sql`${siteImportJobs.productsFound} + ${result.products.length}`,
      productsCreated: sql`${siteImportJobs.productsCreated} + ${created}`,
      productsUpdated: sql`${siteImportJobs.productsUpdated} + ${updated}`,
      variantsUpserted: sql`${siteImportJobs.variantsUpserted} + ${variantsUpserted}`,
      ...(result.skipped.length > 0
        ? { skipped: [...(job.skipped ?? []), ...result.skipped].slice(0, MAX_STORED_SKIPS) }
        : {}),
      ...(done ? { completedAt: clock.now() } : {}),
    })
    .where(eq(siteImportJobs.id, job.id));

  /**
   * The next slot is enqueued only once this one is written.
   *
   * Enqueuing them all up front would be faster and would also mean a failure halfway
   * through leaves seventy-eight messages describing offsets into a catalogue nobody is
   * reading any more.
   */
  if (!done) {
    await deps.siteImportQueue.send({
      jobId: job.id,
      merchantId: message.merchantId,
      siteUrl: message.siteUrl,
      offset: nextOffset,
    });
  }

  return {
    jobId: job.id,
    offset: message.offset,
    method: result.method,
    found: result.products.length,
    created,
    updated,
    variantsUpserted,
    done,
  };
}
