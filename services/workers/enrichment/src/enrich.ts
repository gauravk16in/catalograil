import {
  ENRICHMENT_BATCH_SIZE,
  type Clock,
  type EmbeddingMessage,
  type EnrichmentMessage,
  type Queue,
} from '@catalograil/core';
import { categories, products, type Database } from '@catalograil/db';
import { and, eq, inArray, ne } from 'drizzle-orm';

/**
 * T1.13 — the enrichment worker.
 *
 * Turns a merchant's sparse listing into the structured metadata search actually needs:
 * a category, typed attributes, and the use cases, audience and occasions that feed the
 * intent embedding channel. Batched at 20 products per model call, because the per-call
 * overhead dominates at this size and a merchant uploading 500 products should cost 25
 * calls rather than 500.
 *
 * The rule that shapes everything here is the last one in T1.13: **never overwrite a field
 * a human has edited**. A merchant who fixes our guess and watches it revert the next time
 * a worker runs will not fix the second one, and the catalogue quality this whole system
 * depends on comes from them being willing to correct it.
 */

/** What the model is asked to return, per product. */
export interface EnrichmentResult {
  readonly external_ref: string;
  readonly category_slug: string;
  readonly category_path: string;
  readonly attributes: Record<string, unknown>;
  readonly use_cases: string[];
  readonly target_audience: string[];
  readonly occasions: string[];
  readonly keywords: string[];
  /** 0..1. Below the threshold the category is created for review, not approved. */
  readonly confidence: number;
}

/** The model call, behind an interface so the worker is testable without an API key. */
export interface EnrichmentModel {
  enrich(products: readonly ProductForEnrichment[]): Promise<EnrichmentResult[]>;
}

export interface ProductForEnrichment {
  readonly id: string;
  readonly externalRef: string | null;
  readonly name: string;
  readonly brand: string | null;
  readonly description: string | null;
  readonly categoryHint: string | null;
  readonly attributes: Record<string, unknown>;
  readonly archetype: string;
}

export interface EnrichmentDeps {
  readonly db: Database;
  readonly model: EnrichmentModel;
  readonly embeddingQueue: Queue<EmbeddingMessage>;
  readonly clock: Clock;
}

export interface EnrichmentOutcome {
  readonly requested: number;
  readonly enriched: number;
  readonly skipped: number;
  readonly failed: number;
  readonly categoriesCreated: number;
  readonly categoriesPendingReview: number;
}

/**
 * A category the model is confident about is usable immediately; one it is unsure of is
 * created but held for review, so the taxonomy grows without filling with guesses.
 */
const CONFIDENCE_THRESHOLD = 0.8;

/** Fields the model may write, and the names they carry in `enrichment_source`. */
type EnrichableField =
  'attributes' | 'use_cases' | 'target_audience' | 'occasions' | 'keywords' | 'category_id';

export async function runEnrichment(
  messages: readonly EnrichmentMessage[],
  deps: EnrichmentDeps,
): Promise<EnrichmentOutcome> {
  const ids = [...new Set(messages.map((m) => m.productId))];
  if (ids.length === 0) {
    return {
      requested: 0,
      enriched: 0,
      skipped: 0,
      failed: 0,
      categoriesCreated: 0,
      categoriesPendingReview: 0,
    };
  }

  const loaded = await loadProducts(deps.db, ids);
  const outcome = {
    requested: ids.length,
    enriched: 0,
    skipped: 0,
    failed: 0,
    categoriesCreated: 0,
    categoriesPendingReview: 0,
  };

  for (let i = 0; i < loaded.length; i += ENRICHMENT_BATCH_SIZE) {
    const batch = loaded.slice(i, i + ENRICHMENT_BATCH_SIZE);
    const results = await deps.model.enrich(batch.map(toModelInput));
    const byRef = new Map(results.map((r) => [r.external_ref, r]));

    for (const product of batch) {
      const result = byRef.get(product.externalRef ?? product.id);
      if (!result) {
        outcome.failed++;
        continue;
      }

      try {
        const applied = await applyEnrichment(deps, product, result);
        if (applied.wroteAnything) outcome.enriched++;
        else outcome.skipped++;
        if (applied.categoryCreated) outcome.categoriesCreated++;
        if (applied.categoryPendingReview) outcome.categoriesPendingReview++;
      } catch {
        outcome.failed++;
      }
    }
  }

  /**
   * Enrichment changes the canonical text — use cases and audience are in it — so every
   * touched product has to be re-embedded. The embedding worker's hash check makes this
   * safe to send unconditionally: a product whose text did not actually move costs a hash
   * comparison and nothing more (rule 9).
   */
  await deps.embeddingQueue.sendBatch(
    loaded.map((p) => ({ productId: p.id, merchantId: p.merchantId, reason: 'enriched' as const })),
  );

  return outcome;
}

interface ApplyResult {
  wroteAnything: boolean;
  categoryCreated: boolean;
  categoryPendingReview: boolean;
}

async function applyEnrichment(
  deps: EnrichmentDeps,
  product: LoadedProduct,
  result: EnrichmentResult,
): Promise<ApplyResult> {
  const source = product.enrichmentSource ?? {};
  const applied: ApplyResult = {
    wroteAnything: false,
    categoryCreated: false,
    categoryPendingReview: false,
  };

  /**
   * The core guard. A field marked `human` was edited by the merchant and is now the truth;
   * the model's opinion about it is stale by definition.
   */
  const mayWrite = (field: EnrichableField): boolean => source[field] !== 'human';

  const updates: Record<string, unknown> = {};
  const nextSource: Record<string, string> = { ...source };

  if (mayWrite('attributes') && Object.keys(result.attributes ?? {}).length > 0) {
    // Merged rather than replaced: ingestion may have set attributes from the CSV that the
    // model did not mention, and losing them would be a regression the merchant never asked for.
    updates.attributes = { ...product.attributes, ...result.attributes };
    nextSource.attributes = 'ai';
  }

  for (const [field, value] of [
    ['use_cases', result.use_cases],
    ['target_audience', result.target_audience],
    ['occasions', result.occasions],
    ['keywords', result.keywords],
  ] as const) {
    if (mayWrite(field) && Array.isArray(value) && value.length > 0) {
      updates[field] = value;
      nextSource[field] = 'ai';
    }
  }

  if (mayWrite('category_id') && result.category_slug) {
    const category = await resolveOrCreateCategory(deps, result);
    if (category) {
      updates.category_id = category.id;
      nextSource.category_id = 'ai';
      applied.categoryCreated = category.created;
      applied.categoryPendingReview = category.pendingReview;
    }
  }

  if (Object.keys(updates).length === 0) return applied;

  /**
   * Built as a partial object rather than one statement with COALESCE over every column.
   * The COALESCE version has to bind a null for each field it is *not* writing, and getting
   * a null text[] to bind correctly is fiddly enough that it silently wrote nothing at all
   * — a partial update simply omits what it does not touch, and cannot express that bug.
   */
  await deps.db
    .update(products)
    .set({
      ...(updates.attributes ? { attributes: updates.attributes as Record<string, unknown> } : {}),
      ...(updates.use_cases ? { useCases: updates.use_cases as string[] } : {}),
      ...(updates.target_audience ? { targetAudience: updates.target_audience as string[] } : {}),
      ...(updates.occasions ? { occasions: updates.occasions as string[] } : {}),
      ...(updates.keywords ? { keywords: updates.keywords as string[] } : {}),
      ...(updates.category_id ? { categoryId: updates.category_id as string } : {}),
      enrichmentSource: nextSource as Record<string, never>,
      updatedAt: deps.clock.now(),
    })
    .where(eq(products.id, product.id));

  applied.wroteAnything = true;
  return applied;
}

/**
 * Finds the category by slug, or grows the taxonomy.
 *
 * T1.13 splits on confidence: a confident guess becomes an approved category the catalogue
 * can use immediately, an unsure one is created as `pending_review` so it exists (the
 * product needs somewhere to live) without silently becoming part of the accepted taxonomy.
 * The alternative — refusing to create it — leaves the product uncategorised and invisible
 * to a category filter, which is worse for everyone.
 */
async function resolveOrCreateCategory(
  deps: EnrichmentDeps,
  result: EnrichmentResult,
): Promise<{ id: string; created: boolean; pendingReview: boolean } | null> {
  const slug = normaliseSlug(result.category_slug);
  if (!slug) return null;

  const existing = await deps.db
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.slug, slug))
    .limit(1);

  if (existing[0]) return { id: existing[0].id, created: false, pendingReview: false };

  const pendingReview = (result.confidence ?? 0) < CONFIDENCE_THRESHOLD;
  const path = normalisePath(result.category_path || slug);

  const inserted = await deps.db
    .insert(categories)
    .values({
      slug,
      name: humanise(slug),
      path,
      reviewStatus: pendingReview ? 'pending_review' : 'approved',
    })
    .onConflictDoNothing()
    .returning({ id: categories.id });

  if (inserted[0]) return { id: inserted[0].id, created: true, pendingReview };

  // Lost a race with a concurrent batch; the other one's row is just as good.
  const raced = await deps.db
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.slug, slug))
    .limit(1);
  return raced[0] ? { id: raced[0].id, created: false, pendingReview: false } : null;
}

interface LoadedProduct extends ProductForEnrichment {
  readonly merchantId: string;
  readonly enrichmentSource: Record<string, string> | null;
}

async function loadProducts(db: Database, ids: string[]): Promise<LoadedProduct[]> {
  const rows = await db
    .select({
      id: products.id,
      merchantId: products.merchantId,
      externalRef: products.externalRef,
      name: products.name,
      brand: products.brand,
      description: products.description,
      categoryHint: products.categoryHint,
      attributes: products.attributes,
      archetype: products.archetype,
      enrichmentSource: products.enrichmentSource,
      status: products.status,
    })
    .from(products)
    /**
     * Anything but archived, not just `draft`.
     *
     * A `draft` filter looks right — enrichment is what takes a new product live — but it
     * silently drops the other half of the traffic. T1.12's `updateProduct` queues
     * enrichment for a product that is already `active`, which is precisely the case where
     * a merchant has changed the text and the metadata needs recomputing; those messages
     * were being consumed and discarded without a log line. A seeded catalogue, written
     * `active`, was invisible for the same reason.
     *
     * Re-enriching a live product is safe by construction: `enrichment_source` marks every
     * human-edited field and the merge below refuses to overwrite one.
     */
    .where(and(inArray(products.id, ids), ne(products.status, 'archived')));

  return rows.map((row) => ({
    id: row.id,
    merchantId: row.merchantId,
    externalRef: row.externalRef,
    name: row.name,
    brand: row.brand,
    description: row.description,
    categoryHint: row.categoryHint,
    attributes: row.attributes ?? {},
    archetype: row.archetype,
    enrichmentSource: row.enrichmentSource as Record<string, string> | null,
  }));
}

function toModelInput(product: LoadedProduct): ProductForEnrichment {
  return {
    // The model keys its response by this, so a product without an external_ref uses its id.
    externalRef: product.externalRef ?? product.id,
    id: product.id,
    name: product.name,
    brand: product.brand,
    description: product.description,
    categoryHint: product.categoryHint,
    attributes: product.attributes,
    archetype: product.archetype,
  };
}

export function normaliseSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

/** ltree labels allow only letters, digits and underscore, separated by dots. */
export function normalisePath(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .split(/[.>/]+/)
    .map((label) => label.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''))
    .filter(Boolean)
    .join('.');
}

function humanise(slug: string): string {
  return slug
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export { CONFIDENCE_THRESHOLD };
