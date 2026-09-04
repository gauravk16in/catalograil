import { randomUUID } from 'node:crypto';
import { fixedClock, type EmbeddingMessage } from '@catalograil/core';
import { InMemoryQueue } from '@catalograil/aws';
import { categories, products } from '@catalograil/db';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseEnrichmentResponse } from './claude-model.js';
import {
  normalisePath,
  normaliseSlug,
  runEnrichment,
  type EnrichmentDeps,
  type EnrichmentModel,
  type EnrichmentResult,
  type ProductForEnrichment,
} from './enrich.js';

const DATABASE_URL = process.env.DATABASE_URL;
const NOW = new Date('2026-09-04T12:00:00Z');

/** Returns whatever it is told to, so the worker's own logic is what is under test. */
class ScriptedModel implements EnrichmentModel {
  calls = 0;
  batchSizes: number[] = [];
  constructor(private readonly build: (p: ProductForEnrichment) => Partial<EnrichmentResult>) {}

  async enrich(items: readonly ProductForEnrichment[]): Promise<EnrichmentResult[]> {
    this.calls++;
    this.batchSizes.push(items.length);
    return items.map((item) => ({
      external_ref: item.externalRef,
      category_slug: 'test-category',
      category_path: 'test.category',
      attributes: {},
      use_cases: [],
      target_audience: [],
      occasions: [],
      keywords: [],
      confidence: 0.9,
      ...this.build(item),
    }));
  }
}

describe.skipIf(!DATABASE_URL)('enrichment worker', () => {
  let client: postgres.Sql;
  let db: PostgresJsDatabase;
  let merchantId: string;

  beforeAll(async () => {
    client = postgres(DATABASE_URL!, { max: 2, onnotice: () => {} });
    db = drizzle(client);
    merchantId = randomUUID();
    await client`
      INSERT INTO merchants (id, business_name, contact_email, status)
      VALUES (${merchantId}, 'Enrichment Test Merchant', 'enrich@example.com', 'active')`;
  });

  afterAll(async () => {
    if (merchantId) await client`DELETE FROM merchants WHERE id = ${merchantId}`;
    await client`DELETE FROM categories WHERE slug LIKE 'etest-%' OR slug = 'test-category'`;
    await client?.end();
  });

  beforeEach(async () => {
    await client`DELETE FROM products WHERE merchant_id = ${merchantId}`;
  });

  function deps(model: EnrichmentModel) {
    return {
      db: db as unknown as EnrichmentDeps['db'],
      model,
      embeddingQueue: new InMemoryQueue<EmbeddingMessage>(),
      clock: fixedClock(NOW),
    };
  }

  async function createProduct(ref: string, over: Record<string, unknown> = {}): Promise<string> {
    const [row] = await db
      .insert(products)
      .values({
        merchantId,
        externalRef: ref,
        archetype: 'SIMPLE',
        name: `Product ${ref}`,
        description: 'A product for enrichment tests.',
        status: 'draft',
        ...over,
      })
      .returning({ id: products.id });
    return row!.id;
  }

  async function read(id: string) {
    const [row] = await db.select().from(products).where(eq(products.id, id));
    return row!;
  }

  // ── Core behaviour ───────────────────────────────────────────────────────────

  it('writes the model output and marks every field as ai-sourced', async () => {
    const id = await createProduct('etest-basic');
    const model = new ScriptedModel(() => ({
      category_slug: 'etest-dashcams',
      category_path: 'electronics.etest_dashcams',
      attributes: { resolution: '4K' },
      use_cases: ['night driving'],
      target_audience: ['cab drivers'],
      occasions: ['daily commute'],
      keywords: ['dash camera'],
    }));

    const outcome = await runEnrichment([{ productId: id, merchantId }], deps(model));
    expect(outcome.enriched).toBe(1);

    const row = await read(id);
    expect(row.useCases).toEqual(['night driving']);
    expect(row.targetAudience).toEqual(['cab drivers']);
    expect(row.keywords).toEqual(['dash camera']);
    expect(row.attributes).toMatchObject({ resolution: '4K' });
    expect(row.categoryId).not.toBeNull();

    // Provenance is what makes the next run safe.
    const source = row.enrichmentSource as Record<string, string>;
    expect(source.use_cases).toBe('ai');
    expect(source.attributes).toBe('ai');
    expect(source.category_id).toBe('ai');
  });

  it('merges attributes rather than replacing them', async () => {
    // Ingestion may have set attributes from the CSV that the model does not mention;
    // replacing wholesale would silently drop them.
    const id = await createProduct('etest-merge', { attributes: { warranty_months: 12 } });
    const model = new ScriptedModel(() => ({ attributes: { resolution: '1080p' } }));

    await runEnrichment([{ productId: id, merchantId }], deps(model));

    expect((await read(id)).attributes).toMatchObject({
      warranty_months: 12,
      resolution: '1080p',
    });
  });

  // ── The rule that matters most ───────────────────────────────────────────────

  describe('human edits are never overwritten', () => {
    it('leaves a human-edited field alone and still writes the others', async () => {
      const id = await createProduct('etest-human', {
        useCases: ['what the merchant actually said'],
        enrichmentSource: { use_cases: 'human' },
      });

      const model = new ScriptedModel(() => ({
        use_cases: ['what the model guessed'],
        keywords: ['model-keyword'],
      }));

      await runEnrichment([{ productId: id, merchantId }], deps(model));

      const row = await read(id);
      // A merchant who watches their correction revert will not make a second one.
      expect(row.useCases).toEqual(['what the merchant actually said']);
      // …but untouched fields are still enriched, so one edit does not freeze the product.
      expect(row.keywords).toEqual(['model-keyword']);
      expect((row.enrichmentSource as Record<string, string>).use_cases).toBe('human');
    });

    it('survives a re-run, which is when the overwrite would actually happen', async () => {
      const id = await createProduct('etest-rerun');
      const first = new ScriptedModel(() => ({ use_cases: ['first pass'] }));
      await runEnrichment([{ productId: id, merchantId }], deps(first));

      // The merchant corrects it.
      await db
        .update(products)
        .set({
          useCases: ['merchant correction'],
          enrichmentSource: { use_cases: 'human' },
          status: 'draft',
        })
        .where(eq(products.id, id));

      const second = new ScriptedModel(() => ({ use_cases: ['second pass'] }));
      await runEnrichment([{ productId: id, merchantId }], deps(second));

      expect((await read(id)).useCases).toEqual(['merchant correction']);
    });

    it('leaves a human-chosen category alone', async () => {
      const id = await createProduct('etest-humancat', {
        enrichmentSource: { category_id: 'human' },
      });
      const before = (await read(id)).categoryId;

      await runEnrichment(
        [{ productId: id, merchantId }],
        deps(new ScriptedModel(() => ({ category_slug: 'etest-somewhere-else' }))),
      );

      expect((await read(id)).categoryId).toBe(before);
    });
  });

  // ── Taxonomy growth ──────────────────────────────────────────────────────────

  describe('category creation', () => {
    it('approves a confident new category', async () => {
      const id = await createProduct('etest-confident');
      await runEnrichment(
        [{ productId: id, merchantId }],
        deps(new ScriptedModel(() => ({ category_slug: 'etest-confident-cat', confidence: 0.95 }))),
      );

      const [category] = await db
        .select()
        .from(categories)
        .where(eq(categories.slug, 'etest-confident-cat'));
      expect(category!.reviewStatus).toBe('approved');
    });

    it('holds an unsure category for review rather than refusing it', async () => {
      const id = await createProduct('etest-unsure');
      const outcome = await runEnrichment(
        [{ productId: id, merchantId }],
        deps(new ScriptedModel(() => ({ category_slug: 'etest-unsure-cat', confidence: 0.4 }))),
      );

      const [category] = await db
        .select()
        .from(categories)
        .where(eq(categories.slug, 'etest-unsure-cat'));
      // Created, so the product has somewhere to live, but not yet part of the taxonomy.
      expect(category!.reviewStatus).toBe('pending_review');
      expect(outcome.categoriesPendingReview).toBe(1);
      expect((await read(id)).categoryId).toBe(category!.id);
    });

    it('reuses an existing category rather than duplicating it', async () => {
      const a = await createProduct('etest-reuse-a');
      const b = await createProduct('etest-reuse-b');
      const model = new ScriptedModel(() => ({ category_slug: 'etest-shared-cat' }));

      await runEnrichment(
        [
          { productId: a, merchantId },
          { productId: b, merchantId },
        ],
        deps(model),
      );

      const rows = await db
        .select()
        .from(categories)
        .where(eq(categories.slug, 'etest-shared-cat'));
      expect(rows).toHaveLength(1);
      expect((await read(a)).categoryId).toBe(rows[0]!.id);
      expect((await read(b)).categoryId).toBe(rows[0]!.id);
    });
  });

  // ── Batching and queueing ────────────────────────────────────────────────────

  it('batches at twenty products per model call', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 45; i++) ids.push(await createProduct(`etest-batch-${i}`));

    const model = new ScriptedModel(() => ({}));
    await runEnrichment(
      ids.map((productId) => ({ productId, merchantId })),
      deps(model),
    );

    // 45 products is three calls, not forty-five.
    expect(model.calls).toBe(3);
    expect(model.batchSizes).toEqual([20, 20, 5]);
  }, 120_000);

  it('queues every touched product for re-embedding', async () => {
    const id = await createProduct('etest-queue');
    const d = deps(new ScriptedModel(() => ({})));
    await runEnrichment([{ productId: id, merchantId }], d);

    const queue = d.embeddingQueue as InMemoryQueue<EmbeddingMessage>;
    expect(queue.messages).toHaveLength(1);
    expect(queue.messages[0]).toMatchObject({ productId: id, reason: 'enriched' });
  });

  it('ignores a product that is no longer a draft', async () => {
    const id = await createProduct('etest-active', { status: 'active' });
    const model = new ScriptedModel(() => ({}));
    const outcome = await runEnrichment([{ productId: id, merchantId }], deps(model));
    expect(outcome.enriched).toBe(0);
    expect(model.calls).toBe(0);
  });
});

// ── Response parsing, which needs no database ──────────────────────────────────

describe('parseEnrichmentResponse', () => {
  const requested: ProductForEnrichment[] = [
    {
      id: 'p1',
      externalRef: 'REF-1',
      name: 'Thing',
      brand: null,
      description: null,
      categoryHint: null,
      attributes: {},
      archetype: 'SIMPLE',
    },
  ];

  it('parses a well-formed response', () => {
    const raw = JSON.stringify([
      {
        external_ref: 'REF-1',
        category_slug: 'widgets',
        category_path: 'tools.widgets',
        attributes: { colour: 'red' },
        use_cases: ['fixing things'],
        target_audience: ['diy'],
        occasions: [],
        keywords: ['gadget'],
        confidence: 0.9,
      },
    ]);
    const [result] = parseEnrichmentResponse(raw, requested);
    expect(result!.category_slug).toBe('widgets');
    expect(result!.attributes).toEqual({ colour: 'red' });
  });

  it('tolerates prose wrapped around the array', () => {
    const raw =
      'Here you go:\n[{"external_ref":"REF-1","category_slug":"widgets","confidence":0.9}]\nHope that helps.';
    expect(parseEnrichmentResponse(raw, requested)).toHaveLength(1);
  });

  it('drops a result naming a product that was not in the batch', () => {
    // Applying it would write one product's metadata onto another.
    const raw = JSON.stringify([
      { external_ref: 'SOMETHING-ELSE', category_slug: 'x', confidence: 1 },
    ]);
    expect(parseEnrichmentResponse(raw, requested)).toEqual([]);
  });

  it('rejects unparseable output rather than guessing at it', () => {
    expect(() => parseEnrichmentResponse('not json at all', requested)).toThrow(/not valid JSON/);
  });

  it('clamps a confidence outside 0..1', () => {
    const raw = JSON.stringify([{ external_ref: 'REF-1', category_slug: 'x', confidence: 5 }]);
    expect(parseEnrichmentResponse(raw, requested)[0]!.confidence).toBe(1);
  });

  it('coerces a non-array field to an empty array instead of failing the batch', () => {
    const raw = JSON.stringify([
      { external_ref: 'REF-1', category_slug: 'x', use_cases: 'not an array', confidence: 0.9 },
    ]);
    expect(parseEnrichmentResponse(raw, requested)[0]!.use_cases).toEqual([]);
  });
});

describe('slug and path normalisation', () => {
  it('normalises a slug', () => {
    expect(normaliseSlug('Running Shoes!')).toBe('running-shoes');
    expect(normaliseSlug('  --Car Accessories--  ')).toBe('car-accessories');
  });

  it('normalises a path to valid ltree labels', () => {
    // ltree allows only letters, digits and underscore per label.
    expect(normalisePath('apparel.footwear.running shoes')).toBe('apparel.footwear.running_shoes');
    expect(normalisePath('Electronics > Car Accessories')).toBe('electronics.car_accessories');
  });
});
