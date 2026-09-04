import { AppError, type EnrichmentMessage, type Queue } from '@catalograil/core';
import {
  productPipelineEvents,
  products,
  searchableUnits,
  type Database,
} from '@catalograil/db';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';

/**
 * S5.1–S5.3 — where a product is in the pipeline, why it stopped, and how to push it on.
 *
 * The question this answers is the most common one a merchant will ask: "I uploaded it, why
 * can't anyone find it?" Answering with a status word is not enough — "failed" tells them
 * something is wrong without telling them whether it is their image URL or our model. So the
 * detail view returns the stage timeline and the actual error text.
 */

export interface StageEvent {
  readonly stage: string;
  readonly status: string;
  readonly message: string | null;
  readonly durationMs: number | null;
  readonly at: string;
}

export interface ProductPipelineStatus {
  readonly productId: string;
  readonly productStatus: string;
  readonly unitsTotal: number;
  readonly unitsIndexed: number;
  readonly unitsFailed: number;
  readonly unitsPending: number;
  readonly servingState: string;
  /** Oldest first, so it reads as a timeline. */
  readonly events: StageEvent[];
  /** Populated when something failed, from the unit rows rather than the event log. */
  readonly failureReasons: string[];
}

export async function getPipelineStatus(
  db: Database,
  merchantId: string,
  productId: string,
): Promise<ProductPipelineStatus> {
  const [product] = await db
    .select({ id: products.id, status: products.status })
    .from(products)
    // Scoped by merchant: a product id is not a capability.
    .where(and(eq(products.id, productId), eq(products.merchantId, merchantId)))
    .limit(1);

  if (!product) throw new AppError('NOT_FOUND', 'No such product.');

  const [counts] = await db
    .select({
      total: sql<number>`COUNT(*)::int`,
      indexed: sql<number>`COUNT(*) FILTER (WHERE ${searchableUnits.embeddingStatus} = 'indexed')::int`,
      failed: sql<number>`COUNT(*) FILTER (WHERE ${searchableUnits.embeddingStatus} = 'failed')::int`,
      pending: sql<number>`COUNT(*) FILTER (WHERE ${searchableUnits.embeddingStatus} = 'pending')::int`,
    })
    .from(searchableUnits)
    .where(eq(searchableUnits.productId, productId));

  const events = await db
    .select()
    .from(productPipelineEvents)
    .where(eq(productPipelineEvents.productId, productId))
    .orderBy(productPipelineEvents.createdAt)
    .limit(50);

  const total = counts?.total ?? 0;
  const indexed = counts?.indexed ?? 0;
  const failed = counts?.failed ?? 0;

  return {
    productId,
    productStatus: product.status,
    unitsTotal: total,
    unitsIndexed: indexed,
    unitsFailed: failed,
    unitsPending: counts?.pending ?? 0,
    servingState: deriveState(product.status, total, indexed, failed),
    events: events.map((e) => ({
      stage: e.stage,
      status: e.status,
      message: e.message,
      durationMs: e.durationMs,
      at: e.createdAt.toISOString(),
    })),
    failureReasons: events
      .filter((e) => e.status === 'failed' && e.message)
      .map((e) => e.message!)
      // The same failure repeats across a retry; a merchant needs the distinct causes.
      .filter((msg, i, all) => all.indexOf(msg) === i)
      .slice(0, 5),
  };
}

export function deriveState(
  productStatus: string,
  total: number,
  indexed: number,
  failed: number,
): string {
  if (productStatus === 'archived') return 'archived';
  if (productStatus === 'draft' && total === 0) return 'draft';
  if (total === 0) return 'processing';
  if (indexed === total) return 'indexed';
  if (failed === total) return 'failed';
  if (indexed > 0) return 'partial';
  return 'processing';
}

export interface RetryDeps {
  readonly db: Database;
  readonly enrichmentQueue: Queue<EnrichmentMessage>;
}

/**
 * Re-enqueues products for the pipeline.
 *
 * Always from enrichment rather than from embedding, even when only embedding failed.
 * Enrichment is keyed on `content_hash` and skips work that is already done, so starting at
 * the front costs nothing and removes a whole class of "retried the wrong stage" bug. Rule 9
 * still holds: unchanged content re-embeds nothing.
 */
export async function retryProducts(
  deps: RetryDeps,
  merchantId: string,
  productIds: readonly string[],
): Promise<{ requeued: number }> {
  if (productIds.length === 0) return { requeued: 0 };

  // Filtered through the database rather than trusted: the ids arrive from a client, and
  // one belonging to another merchant must not be actionable.
  const owned = await deps.db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.merchantId, merchantId), inArray(products.id, [...productIds])));

  for (const row of owned) {
    await deps.enrichmentQueue.send({ productId: row.id, merchantId });
  }

  return { requeued: owned.length };
}

/** Every product of this merchant that search cannot currently serve. */
export async function retryAllFailed(
  deps: RetryDeps,
  merchantId: string,
): Promise<{ requeued: number }> {
  const rows = await deps.db
    .select({ id: products.id })
    .from(products)
    .where(
      and(
        eq(products.merchantId, merchantId),
        sql`${products.status} <> 'archived'`,
        sql`NOT EXISTS (
          SELECT 1 FROM ${searchableUnits}
          WHERE ${searchableUnits.productId} = ${products.id}
            AND ${searchableUnits.embeddingStatus} = 'indexed'
        )`,
      ),
    )
    .limit(500);

  for (const row of rows) {
    await deps.enrichmentQueue.send({ productId: row.id, merchantId });
  }
  return { requeued: rows.length };
}

/** Written by every worker. Failures here must never fail the work they describe. */
export async function recordEvent(
  db: Database,
  event: {
    productId: string;
    stage: string;
    status: string;
    message?: string | null;
    durationMs?: number | null;
  },
): Promise<void> {
  try {
    await db.insert(productPipelineEvents).values({
      productId: event.productId,
      stage: event.stage,
      status: event.status,
      message: event.message ?? null,
      durationMs: event.durationMs ?? null,
    });
  } catch {
    // Observability must not be able to break the pipeline it observes.
  }
}

/** Dashboard summary card (S5.2). */
export async function catalogueSummary(
  db: Database,
  merchantId: string,
): Promise<{ total: number; ready: number; processing: number; failed: number }> {
  const rows = await db
    .select({
      status: products.status,
      total: sql<number>`COUNT(*)::int`,
      indexed: sql<number>`COUNT(*) FILTER (WHERE ${searchableUnits.embeddingStatus} = 'indexed')::int`,
      failed: sql<number>`COUNT(*) FILTER (WHERE ${searchableUnits.embeddingStatus} = 'failed')::int`,
      productId: products.id,
    })
    .from(products)
    .leftJoin(searchableUnits, eq(searchableUnits.productId, products.id))
    .where(and(eq(products.merchantId, merchantId), sql`${products.status} <> 'archived'`))
    .groupBy(products.id, products.status);

  let ready = 0;
  let processing = 0;
  let failed = 0;
  for (const row of rows) {
    const state = deriveState(row.status, row.total, row.indexed, row.failed);
    if (state === 'indexed') ready++;
    else if (state === 'failed') failed++;
    else if (state !== 'draft' && state !== 'archived') processing++;
  }

  return { total: rows.length, ready, processing, failed };
}
