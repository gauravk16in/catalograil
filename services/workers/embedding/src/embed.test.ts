import { EMBEDDING_DIMENSIONS, fixedClock } from '@catalograil/core';
import { productVariants, products, searchableUnits } from '@catalograil/db';
import {
  InMemoryEmbeddingCache,
  type Embedder,
  type ImageFetcher,
  type ImagePayload,
  type InputType,
} from '@catalograil/embeddings';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runEmbedding, type EmbeddingDeps } from './embed.js';

/**
 * Runs against the real seeded catalogue, with a counting fake in place of Bedrock.
 *
 * The fake is the right tool here precisely because the assertions are about *how many*
 * calls happen, not what comes back: rule 9 is a claim about cost, and the only way to
 * test a cost claim is to count. The vectors themselves are verified against live Bedrock
 * in `packages/embeddings/src/bedrock.live.test.ts`.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const NOW = new Date('2026-09-04T12:00:00Z');

/** Deterministic unit vector, so a stored embedding can be recognised. */
function fakeVector(seed: string): number[] {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => ((h + i) % 200) / 100 - 1);
}

class CountingEmbedder implements Embedder {
  textCalls = 0;
  textsEmbedded = 0;
  imageCalls = 0;

  async embedTexts(texts: readonly string[], _inputType: InputType): Promise<number[][]> {
    if (texts.length === 0) return [];
    this.textCalls++;
    this.textsEmbedded += texts.length;
    return texts.map((t) => fakeVector(t));
  }

  async embedImage(image: ImagePayload): Promise<number[] | null> {
    this.imageCalls++;
    return fakeVector(`img:${image.bytes.length}`);
  }
}

class FakeImageFetcher implements ImageFetcher {
  fetches = 0;
  constructor(private readonly broken = new Set<string>()) {}

  async fetch(url: string): Promise<ImagePayload | null> {
    this.fetches++;
    if (this.broken.has(url)) return null;
    return { bytes: new Uint8Array([1, 2, 3, 4]), contentType: 'image/jpeg' };
  }
}

describe.skipIf(!DATABASE_URL)('embedding worker', () => {
  let client: postgres.Sql;
  let db: PostgresJsDatabase;
  let merchantId: string;

  beforeAll(async () => {
    client = postgres(DATABASE_URL!, { max: 2, onnotice: () => {} });
    db = drizzle(client);
    // The apparel merchant from the seed: VARIANT products with real option matrices.
    merchantId = '22222222-2222-4222-8222-222222222222';
  });

  afterAll(async () => {
    await client?.end();
  });

  function deps(embedder = new CountingEmbedder(), fetcher = new FakeImageFetcher()) {
    return {
      db: db as unknown as EmbeddingDeps['db'],
      embedder,
      imageFetcher: fetcher,
      imageCache: new InMemoryEmbeddingCache(),
      clock: fixedClock(NOW),
    };
  }

  async function pickProduct(externalRef: string): Promise<string> {
    const [row] = await db
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.merchantId, merchantId), eq(products.externalRef, externalRef)));
    return row!.id;
  }

  /** Seeded products are not enriched, so intent text is supplied here. */
  async function enrich(productId: string): Promise<void> {
    await db
      .update(products)
      .set({
        useCases: ['office wear', 'smart casual'],
        targetAudience: ['men'],
        occasions: ['work'],
        images: ['https://example.com/shirt.jpg'],
      })
      .where(eq(products.id, productId));
  }

  async function clearUnits(productId: string): Promise<void> {
    await db.delete(searchableUnits).where(eq(searchableUnits.productId, productId));
  }

  // ── Acceptance: expansion and all three vectors ───────────────────────────────

  describe('expansion', () => {
    let productId: string;

    beforeEach(async () => {
      productId = await pickProduct('AP-SHIRT-001');
      await enrich(productId);
      await clearUnits(productId);
    });

    it('creates one unit per variant with all three vectors populated', async () => {
      const d = deps();
      const outcome = await runEmbedding({ productId, merchantId, reason: 'ingested' }, d);

      const variantCount = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(productVariants)
        .where(eq(productVariants.productId, productId));

      expect(outcome.unitsTotal).toBe(variantCount[0]!.n);
      expect(outcome.unitsEmbedded).toBe(outcome.unitsTotal);

      const rows = await db
        .select({
          unitType: searchableUnits.unitType,
          variantId: searchableUnits.variantId,
          status: searchableUnits.embeddingStatus,
          hasSemantic: sql<boolean>`${searchableUnits.vSemantic} IS NOT NULL`,
          hasIntent: sql<boolean>`${searchableUnits.vIntent} IS NOT NULL`,
          hasVisual: sql<boolean>`${searchableUnits.vVisual} IS NOT NULL`,
        })
        .from(searchableUnits)
        .where(eq(searchableUnits.productId, productId));

      expect(rows).toHaveLength(outcome.unitsTotal);
      expect(rows.every((r) => r.unitType === 'variant' && r.variantId !== null)).toBe(true);
      expect(rows.every((r) => r.status === 'indexed')).toBe(true);
      expect(rows.every((r) => r.hasSemantic && r.hasIntent && r.hasVisual)).toBe(true);
    }, 120_000);

    it('batches the whole product into two text calls, not two per unit', async () => {
      const embedder = new CountingEmbedder();
      await runEmbedding({ productId, merchantId, reason: 'ingested' }, deps(embedder));
      // One batch for canonical text, one for intent.
      expect(embedder.textCalls).toBe(2);
    }, 120_000);

    it('embeds a shared image once across every variant', async () => {
      const embedder = new CountingEmbedder();
      const fetcher = new FakeImageFetcher();
      const outcome = await runEmbedding(
        { productId, merchantId, reason: 'ingested' },
        deps(embedder, fetcher),
      );

      // Every variant of this product shares one photo, so it is fetched and embedded once.
      expect(outcome.unitsEmbedded).toBeGreaterThan(1);
      expect(embedder.imageCalls).toBe(1);
      expect(fetcher.fetches).toBe(1);
    }, 120_000);

    it('creates one product-typed unit for a SIMPLE product', async () => {
      const simpleId = await pickSimple();
      await clearUnits(simpleId);
      const outcome = await runEmbedding(
        {
          productId: simpleId,
          merchantId: '11111111-1111-4111-8111-111111111111',
          reason: 'ingested',
        },
        deps(),
      );

      expect(outcome.unitsTotal).toBe(1);
      const rows = await db
        .select({ unitType: searchableUnits.unitType, variantId: searchableUnits.variantId })
        .from(searchableUnits)
        .where(eq(searchableUnits.productId, simpleId));
      expect(rows[0]?.unitType).toBe('product');
      expect(rows[0]?.variantId).toBeNull();
    }, 120_000);
  });

  // ── Acceptance: rule 9, the cost control ──────────────────────────────────────

  describe('re-embedding only on a content change (rule 9)', () => {
    let productId: string;

    beforeEach(async () => {
      productId = await pickProduct('AP-SHIRT-002');
      await enrich(productId);
      await clearUnits(productId);
      await runEmbedding({ productId, merchantId, reason: 'ingested' }, deps());
    });

    it('embeds nothing at all on an unchanged re-run', async () => {
      const embedder = new CountingEmbedder();
      const outcome = await runEmbedding(
        { productId, merchantId, reason: 'edited' },
        deps(embedder),
      );

      expect(outcome.unitsSkipped).toBe(outcome.unitsTotal);
      expect(outcome.unitsEmbedded).toBe(0);
      expect(embedder.textCalls).toBe(0);
      expect(embedder.imageCalls).toBe(0);
    }, 120_000);

    it('embeds nothing when a price changes', async () => {
      // The case that would bankrupt the pipeline if the hash included price.
      await db
        .update(productVariants)
        .set({ pricePaise: 999900n })
        .where(eq(productVariants.productId, productId));

      const embedder = new CountingEmbedder();
      const outcome = await runEmbedding(
        { productId, merchantId, reason: 'edited' },
        deps(embedder),
      );

      expect(embedder.textsEmbedded).toBe(0);
      expect(outcome.unitsEmbedded).toBe(0);

      // …but the filterable really was refreshed.
      const [row] = await db
        .select({ price: searchableUnits.pricePaise })
        .from(searchableUnits)
        .where(eq(searchableUnits.productId, productId))
        .limit(1);
      expect(row?.price).toBe(999900n);
    }, 120_000);

    it('embeds nothing when stock changes, and reflects it in the filterable', async () => {
      await db
        .update(productVariants)
        .set({ stock: 0 })
        .where(eq(productVariants.productId, productId));

      const embedder = new CountingEmbedder();
      await runEmbedding({ productId, merchantId, reason: 'edited' }, deps(embedder));

      expect(embedder.textsEmbedded).toBe(0);
      const rows = await db
        .select({ inStock: searchableUnits.inStock })
        .from(searchableUnits)
        .where(eq(searchableUnits.productId, productId));
      expect(rows.every((r) => r.inStock === false)).toBe(true);
    }, 120_000);

    it('re-embeds every unit of the product when the description changes', async () => {
      // Unique per run: these columns are not restored afterwards, so a fixed string
      // would already be in place on a second run and the hash would rightly not move.
      await db
        .update(products)
        .set({ description: `Now woven from a heavier linen. (${Date.now()})` })
        .where(eq(products.id, productId));

      const embedder = new CountingEmbedder();
      const outcome = await runEmbedding(
        { productId, merchantId, reason: 'edited' },
        deps(embedder),
      );

      // The description is in every variant's canonical text, so every unit's hash moved.
      expect(outcome.unitsEmbedded).toBe(outcome.unitsTotal);
      expect(outcome.unitsSkipped).toBe(0);
      expect(embedder.textsEmbedded).toBeGreaterThan(0);
    }, 120_000);

    it('re-embeds exactly one unit when a single variant changes', async () => {
      const [variant] = await db
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(eq(productVariants.productId, productId))
        .limit(1);

      // Delivery days is part of the canonical text, so this moves one unit's hash only.
      // Derived from the current value so the change is real on every run.
      const [current] = await db
        .select({ days: productVariants.deliveryDays })
        .from(productVariants)
        .where(eq(productVariants.id, variant!.id));
      await db
        .update(productVariants)
        .set({ deliveryDays: ((current?.days ?? 3) % 12) + 1 })
        .where(eq(productVariants.id, variant!.id));

      const embedder = new CountingEmbedder();
      const outcome = await runEmbedding(
        { productId, merchantId, reason: 'edited' },
        deps(embedder),
      );

      expect(outcome.unitsEmbedded).toBe(1);
      expect(outcome.unitsSkipped).toBe(outcome.unitsTotal - 1);
    }, 120_000);
  });

  // ── Acceptance: a broken image degrades gracefully ────────────────────────────

  it('indexes the unit with a null v_visual when the image cannot be fetched', async () => {
    const productId = await pickProduct('AP-SHIRT-003');
    await db
      .update(products)
      .set({
        useCases: ['office wear'],
        targetAudience: ['men'],
        images: ['https://example.com/deleted.jpg'],
      })
      .where(eq(products.id, productId));
    await clearUnits(productId);

    const fetcher = new FakeImageFetcher(new Set(['https://example.com/deleted.jpg']));
    const outcome = await runEmbedding(
      { productId, merchantId, reason: 'ingested' },
      deps(new CountingEmbedder(), fetcher),
    );

    expect(outcome.unitsEmbedded).toBe(outcome.unitsTotal);
    expect(outcome.unitsFailed).toBe(0);
    expect(outcome.imagesFailed).toBeGreaterThan(0);

    const rows = await db
      .select({
        status: searchableUnits.embeddingStatus,
        hasSemantic: sql<boolean>`${searchableUnits.vSemantic} IS NOT NULL`,
        hasVisual: sql<boolean>`${searchableUnits.vVisual} IS NOT NULL`,
      })
      .from(searchableUnits)
      .where(eq(searchableUnits.productId, productId));

    // Indexed and searchable on text, just without the visual channel.
    expect(rows.every((r) => r.status === 'indexed')).toBe(true);
    expect(rows.every((r) => r.hasSemantic)).toBe(true);
    expect(rows.every((r) => !r.hasVisual)).toBe(true);
  }, 120_000);

  async function pickSimple(): Promise<string> {
    const [row] = await db
      .select({ id: products.id })
      .from(products)
      .where(
        and(
          eq(products.externalRef, 'EL-DASH-001'),
          eq(products.merchantId, '11111111-1111-4111-8111-111111111111'),
        ),
      );
    return row!.id;
  }
});
