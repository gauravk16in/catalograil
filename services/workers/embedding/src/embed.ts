import { AppError, type Clock, type EmbeddingMessage } from '@catalograil/core';
import {
  categories,
  merchantMetrics,
  merchants,
  productOptionAxes,
  productVariants,
  products,
  searchableUnits,
  type Database,
} from '@catalograil/db';
import {
  embedImageCached,
  type Embedder,
  type EmbeddingCache,
  type ImageFetcher,
} from '@catalograil/embeddings';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { expandProduct, type ExpandedUnit, type ProductForExpansion } from './expand.js';

/**
 * T1.15 — the embedding worker.
 *
 * The shape of this file is dictated by rule 9 and step 3 of the task: comparing
 * `content_hash` comes *first*, and a unit whose hash is unchanged has its denormalised
 * filterables updated and is never sent to Bedrock. That branch is the cost control for
 * the whole system — a merchant repricing a 200-variant catalogue must cost zero
 * embeddings — so it is the first thing that happens to every unit, and the tests assert
 * it by counting calls rather than by inspecting output.
 */

export interface EmbeddingDeps {
  readonly db: Database;
  readonly embedder: Embedder;
  readonly imageFetcher: ImageFetcher;
  readonly imageCache: EmbeddingCache;
  readonly clock: Clock;
}

export interface EmbeddingOutcome {
  readonly productId: string;
  readonly unitsTotal: number;
  /** Units whose hash was unchanged: filterables refreshed, no Bedrock call. */
  readonly unitsSkipped: number;
  readonly unitsEmbedded: number;
  readonly unitsFailed: number;
  readonly imagesEmbedded: number;
  readonly imagesFailed: number;
}

export async function runEmbedding(
  message: EmbeddingMessage,
  deps: EmbeddingDeps,
): Promise<EmbeddingOutcome> {
  const product = await loadProduct(deps.db, message.productId);
  if (!product) {
    throw new AppError('NOT_FOUND', `No product ${message.productId}.`, {
      retryable: false,
      details: { productId: message.productId },
    });
  }

  const units = expandProduct(product);
  const existing = await loadExistingHashes(deps.db, message.productId);

  const unchanged: ExpandedUnit[] = [];
  const changed: ExpandedUnit[] = [];

  for (const unit of units) {
    const previous = existing.get(unitKey(unit));
    // Rule 9, and the first branch as the task requires.
    if (previous?.contentHash === unit.contentHash && previous.embeddingStatus === 'indexed') {
      unchanged.push(unit);
    } else {
      changed.push(unit);
    }
  }

  await refreshFilterables(deps, unchanged);
  const embedded = await embedAndUpsert(deps, changed);

  return {
    productId: message.productId,
    unitsTotal: units.length,
    unitsSkipped: unchanged.length,
    unitsEmbedded: embedded.succeeded,
    unitsFailed: embedded.failed,
    imagesEmbedded: embedded.imagesEmbedded,
    imagesFailed: embedded.imagesFailed,
  };
}

/**
 * The cheap path. Price, stock, delivery, merchant status and trust all change constantly
 * and none of them is in the canonical text, so they are written straight to the existing
 * row without touching a vector.
 */
async function refreshFilterables(
  deps: EmbeddingDeps,
  units: readonly ExpandedUnit[],
): Promise<void> {
  for (const unit of units) {
    await deps.db
      .update(searchableUnits)
      .set({
        pricePaise: unit.pricePaise,
        inStock: unit.inStock,
        deliveryDays: unit.deliveryDays,
        attributes: unit.attributes,
        merchantStatus: unit.merchantStatus,
        trustScore: unit.trustScore,
        categoryId: unit.categoryId,
        categoryPath: unit.categoryPath,
        updatedAt: deps.clock.now(),
      })
      .where(matchUnit(unit));
  }
}

interface EmbedResult {
  succeeded: number;
  failed: number;
  imagesEmbedded: number;
  imagesFailed: number;
}

async function embedAndUpsert(
  deps: EmbeddingDeps,
  units: readonly ExpandedUnit[],
): Promise<EmbedResult> {
  const result: EmbedResult = { succeeded: 0, failed: 0, imagesEmbedded: 0, imagesFailed: 0 };
  if (units.length === 0) return result;

  /**
   * Both text channels for the whole product go in two batched calls rather than two per
   * unit. A 24-variant product is 2 requests instead of 48.
   *
   * Units with no intent text are excluded from that batch rather than sent as empty
   * strings — an empty embedding is a real vector pointing somewhere meaningless, which
   * would match arbitrary queries.
   */
  const semanticVectors = await deps.embedder.embedTexts(
    units.map((u) => u.canonicalText),
    'search_document',
  );

  const intentIndices = units.map((u, i) => (u.intentText ? i : -1)).filter((i) => i >= 0);
  const intentVectors = await deps.embedder.embedTexts(
    intentIndices.map((i) => units[i]!.intentText),
    'search_document',
  );
  const intentByIndex = new Map(intentIndices.map((unitIndex, i) => [unitIndex, intentVectors[i]]));

  for (const [index, unit] of units.entries()) {
    try {
      const semantic = semanticVectors[index];
      if (!semantic) throw new AppError('EMBEDDING_FAILED', 'No semantic vector returned.');

      let visual: number[] | null = null;
      if (unit.primaryImageUrl) {
        visual = await embedImageCached(unit.primaryImageUrl, {
          embedder: deps.embedder,
          fetcher: deps.imageFetcher,
          cache: deps.imageCache,
        });
        // A broken image URL is ordinary. T1.15 requires the unit to index anyway.
        if (visual) result.imagesEmbedded++;
        else result.imagesFailed++;
      }

      await upsertUnit(deps, unit, {
        semantic,
        intent: intentByIndex.get(index) ?? null,
        visual,
      });
      result.succeeded++;
    } catch (err) {
      await markFailed(deps, unit);
      result.failed++;
      if (!(err instanceof AppError) || err.retryable) throw err;
    }
  }

  return result;
}

async function upsertUnit(
  deps: EmbeddingDeps,
  unit: ExpandedUnit,
  vectors: { semantic: number[]; intent: number[] | null; visual: number[] | null },
): Promise<void> {
  const row = {
    unitType: unit.unitType,
    productId: unit.productId,
    variantId: unit.variantId,
    merchantId: unit.merchantId,
    archetype: unit.archetype,
    categoryId: unit.categoryId,
    categoryPath: unit.categoryPath,
    pricePaise: unit.pricePaise,
    inStock: unit.inStock,
    deliveryDays: unit.deliveryDays,
    attributes: unit.attributes,
    merchantStatus: unit.merchantStatus,
    trustScore: unit.trustScore,
    canonicalText: unit.canonicalText,
    contentHash: unit.contentHash,
    vSemantic: vectors.semantic,
    vIntent: vectors.intent,
    vVisual: vectors.visual,
    embeddingStatus: 'indexed' as const,
    updatedAt: deps.clock.now(),
  };

  const existing = await deps.db
    .select({ id: searchableUnits.id })
    .from(searchableUnits)
    .where(matchUnit(unit))
    .limit(1);

  if (existing[0]) {
    await deps.db.update(searchableUnits).set(row).where(eq(searchableUnits.id, existing[0].id));
  } else {
    await deps.db.insert(searchableUnits).values(row);
  }
}

async function markFailed(deps: EmbeddingDeps, unit: ExpandedUnit): Promise<void> {
  await deps.db
    .update(searchableUnits)
    .set({ embeddingStatus: 'failed', updatedAt: deps.clock.now() })
    .where(matchUnit(unit));
}

/**
 * A unit is identified by its product and variant, not by an id we generate — the worker
 * has to find the row it wrote last time in order to compare hashes.
 */
function matchUnit(unit: ExpandedUnit) {
  return unit.variantId
    ? and(
        eq(searchableUnits.productId, unit.productId),
        eq(searchableUnits.variantId, unit.variantId),
      )
    : and(eq(searchableUnits.productId, unit.productId), sql`${searchableUnits.variantId} IS NULL`);
}

function unitKey(unit: { productId: string; variantId: string | null }): string {
  return `${unit.productId}:${unit.variantId ?? ''}`;
}

/**
 * Reads only what is needed. Never `SELECT *` on searchable_units (never-do #1) — the
 * three vector columns are 4KB each and none of them is wanted here.
 */
async function loadExistingHashes(
  db: Database,
  productId: string,
): Promise<Map<string, { contentHash: string; embeddingStatus: string }>> {
  const rows = await db
    .select({
      productId: searchableUnits.productId,
      variantId: searchableUnits.variantId,
      contentHash: searchableUnits.contentHash,
      embeddingStatus: searchableUnits.embeddingStatus,
    })
    .from(searchableUnits)
    .where(eq(searchableUnits.productId, productId));

  return new Map(
    rows.map((r) => [
      unitKey(r),
      { contentHash: r.contentHash, embeddingStatus: r.embeddingStatus },
    ]),
  );
}

async function loadProduct(db: Database, productId: string): Promise<ProductForExpansion | null> {
  const rows = await db
    .select({
      id: products.id,
      merchantId: products.merchantId,
      archetype: products.archetype,
      name: products.name,
      brand: products.brand,
      description: products.description,
      categoryId: products.categoryId,
      categoryPath: sql<string | null>`${categories.path}::text`,
      attributes: products.attributes,
      useCases: products.useCases,
      targetAudience: products.targetAudience,
      occasions: products.occasions,
      images: products.images,
      routeOrScope: products.routeOrScope,
      priceRangeHint: products.priceRangeHint,
      merchantStatus: merchants.status,
      trustScore: merchantMetrics.trustScore,
    })
    .from(products)
    .innerJoin(merchants, eq(merchants.id, products.merchantId))
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .leftJoin(merchantMetrics, eq(merchantMetrics.merchantId, products.merchantId))
    .where(eq(products.id, productId))
    .limit(1);

  const product = rows[0];
  if (!product) return null;

  const [variants, axes] = await Promise.all([
    db.select().from(productVariants).where(eq(productVariants.productId, productId)),
    db
      .select()
      .from(productOptionAxes)
      .where(eq(productOptionAxes.productId, productId))
      .orderBy(productOptionAxes.displayOrder),
  ]);

  return {
    ...product,
    optionAxes: axes.map((a) => ({ name: a.axisName, values: a.axisValues ?? [] })),
    variants: variants.map((v) => ({
      id: v.id,
      sku: v.sku,
      optionValues: v.optionValues,
      pricePaise: v.pricePaise,
      stock: v.stock,
      deliveryDays: v.deliveryDays,
      images: v.images,
      status: v.status,
    })),
  };
}

/** Batch entry point: several products at once, sharing one image cache. */
export async function runEmbeddingBatch(
  messages: readonly EmbeddingMessage[],
  deps: EmbeddingDeps,
): Promise<EmbeddingOutcome[]> {
  const outcomes: EmbeddingOutcome[] = [];
  for (const message of messages) {
    outcomes.push(await runEmbedding(message, deps));
  }
  return outcomes;
}

/** Used by the denormalisation sync (T1.16) to refresh many units after a merchant change. */
export async function refreshMerchantUnits(
  db: Database,
  merchantId: string,
  patch: { merchantStatus?: string; trustScore?: string | null },
): Promise<number> {
  const ids = await db
    .select({ id: searchableUnits.id })
    .from(searchableUnits)
    .where(eq(searchableUnits.merchantId, merchantId));

  if (ids.length === 0) return 0;

  await db
    .update(searchableUnits)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      inArray(
        searchableUnits.id,
        ids.map((r) => r.id),
      ),
    );
  return ids.length;
}
