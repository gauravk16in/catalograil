import { randomUUID } from 'node:crypto';
import { fixedClock, type EnrichmentMessage } from '@catalograil/core';
import { InMemoryQueue } from '@catalograil/aws';
import { productOptionAxes, productVariants, products } from '@catalograil/db';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  archiveProduct,
  createProduct,
  restoreProduct,
  updateProduct,
  type ProductDeps,
} from './products.js';

const DATABASE_URL = process.env.DATABASE_URL;
const NOW = new Date('2026-09-04T12:00:00Z');

describe.skipIf(!DATABASE_URL)('manual product endpoints', () => {
  let client: postgres.Sql;
  let db: PostgresJsDatabase;
  let merchantId: string;

  beforeAll(async () => {
    client = postgres(DATABASE_URL!, { max: 2, onnotice: () => {} });
    db = drizzle(client);
    merchantId = randomUUID();
    await client`
      INSERT INTO merchants (id, business_name, contact_email, status)
      VALUES (${merchantId}, 'Product API Merchant', 'products@example.com', 'active')`;
  });

  afterAll(async () => {
    if (merchantId) await client`DELETE FROM merchants WHERE id = ${merchantId}`;
    await client?.end();
  });

  function deps(): ProductDeps & { enrichmentQueue: InMemoryQueue<EnrichmentMessage> } {
    return {
      db: db as unknown as ProductDeps['db'],
      enrichmentQueue: new InMemoryQueue<EnrichmentMessage>(),
      clock: fixedClock(NOW),
    };
  }

  // ── Acceptance: 3 axes, 24 combinations, one call ────────────────────────────

  it('creates a 24-variant product from a 3-axis matrix in one call', async () => {
    const sizes = ['38', '40', '42', '44'];
    const colours = ['white', 'sky', 'lilac'];
    const fabrics = ['cotton', 'linen'];

    const variants = sizes.flatMap((size) =>
      colours.flatMap((colour) =>
        fabrics.map((fabric) => ({
          sku: `MATRIX-${size}-${colour}-${fabric}`.toUpperCase(),
          optionValues: { size, colour, fabric },
          price: '1899',
          mrp: '2799',
          stock: 5,
          deliveryDays: 3,
          images: [],
        })),
      ),
    );
    expect(variants).toHaveLength(24);

    const d = deps();
    const result = await createProduct(d, merchantId, {
      externalRef: 'MATRIX-001',
      archetype: 'VARIANT',
      name: 'Three Axis Shirt',
      description: 'A shirt sold along three axes.',
      attributes: {},
      images: [],
      optionAxes: [
        { name: 'size', values: sizes },
        { name: 'colour', values: colours },
        { name: 'fabric', values: fabrics },
      ],
      variants,
    });

    expect(result.variantsCreated).toBe(24);

    const rows = await db
      .select()
      .from(productVariants)
      .where(eq(productVariants.productId, result.productId));
    expect(rows).toHaveLength(24);
    expect(rows[0]!.pricePaise).toBe(189900n);

    const axes = await db
      .select()
      .from(productOptionAxes)
      .where(eq(productOptionAxes.productId, result.productId));
    expect(axes).toHaveLength(3);
    expect(axes.map((a) => a.axisName).sort()).toEqual(['colour', 'fabric', 'size']);

    // Draft until indexed, and queued for enrichment.
    expect(result.status).toBe('draft');
    expect(d.enrichmentQueue.messages).toHaveLength(1);
  }, 60_000);

  it('creates a simple product with its single variant', async () => {
    const d = deps();
    const result = await createProduct(d, merchantId, {
      externalRef: 'SIMPLE-001',
      archetype: 'SIMPLE',
      name: 'A Simple Dashcam',
      attributes: { resolution: '4K' },
      images: [],
      optionAxes: [],
      variants: [{ sku: 'SIMPLE-001', optionValues: {}, price: '8499', stock: 10, images: [] }],
    });
    expect(result.variantsCreated).toBe(1);
  });

  // ── Validation that protects the matrix ──────────────────────────────────────

  describe('validation', () => {
    const base = {
      archetype: 'VARIANT' as const,
      name: 'Bad Product',
      attributes: {},
      images: [],
      optionAxes: [{ name: 'size', values: ['S', 'M'] }],
    };

    it('rejects a variant missing a value for a declared axis', async () => {
      // A hole in the matrix means a buyer can select a combination that resolves to
      // nothing, so it is refused at the boundary rather than discovered at checkout.
      await expect(
        createProduct(deps(), merchantId, {
          ...base,
          externalRef: 'BAD-1',
          variants: [{ sku: 'BAD-1-S', optionValues: {}, price: '100', stock: 1, images: [] }],
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('rejects a variant product with no axes', async () => {
      await expect(
        createProduct(deps(), merchantId, {
          ...base,
          externalRef: 'BAD-2',
          optionAxes: [],
          variants: [{ sku: 'BAD-2', optionValues: {}, price: '100', stock: 1, images: [] }],
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('rejects a simple product with several variants', async () => {
      await expect(
        createProduct(deps(), merchantId, {
          archetype: 'SIMPLE',
          name: 'Confused',
          externalRef: 'BAD-3',
          attributes: {},
          images: [],
          optionAxes: [],
          variants: [
            { sku: 'A', optionValues: {}, price: '100', stock: 1, images: [] },
            { sku: 'B', optionValues: {}, price: '100', stock: 1, images: [] },
          ],
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('rejects a duplicate SKU', async () => {
      await expect(
        createProduct(deps(), merchantId, {
          ...base,
          externalRef: 'BAD-4',
          variants: [
            { sku: 'DUP', optionValues: { size: 'S' }, price: '100', stock: 1, images: [] },
            { sku: 'DUP', optionValues: { size: 'M' }, price: '100', stock: 1, images: [] },
          ],
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('rejects a price that is not a rupee amount', async () => {
      await expect(
        createProduct(deps(), merchantId, {
          archetype: 'SIMPLE',
          name: 'Bad Price',
          externalRef: 'BAD-5',
          attributes: {},
          images: [],
          optionAxes: [],
          variants: [{ sku: 'BAD-5', optionValues: {}, price: '12.999', stock: 1, images: [] }],
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('leaves nothing behind when creation fails', async () => {
      const before = await db.select().from(products).where(eq(products.merchantId, merchantId));
      await expect(
        createProduct(deps(), merchantId, { ...base, externalRef: 'BAD-6', variants: [] }),
      ).rejects.toThrow();
      const after = await db.select().from(products).where(eq(products.merchantId, merchantId));
      expect(after).toHaveLength(before.length);
    });
  });

  // ── Update marks edits as human ──────────────────────────────────────────────

  it('marks an edited field as human so enrichment cannot overwrite it', async () => {
    const d = deps();
    const created = await createProduct(d, merchantId, {
      externalRef: 'EDIT-001',
      archetype: 'SIMPLE',
      name: 'Editable Product',
      attributes: { colour: 'red' },
      images: [],
      optionAxes: [],
      variants: [{ sku: 'EDIT-001', optionValues: {}, price: '500', stock: 2, images: [] }],
    });

    await updateProduct(d, merchantId, created.productId, {
      attributes: { colour: 'blue', material: 'steel' },
    });

    const [row] = await db.select().from(products).where(eq(products.id, created.productId));
    expect(row!.attributes).toMatchObject({ colour: 'blue', material: 'steel' });
    // This marking is the whole point of an edit — without it, T1.13 reverts it silently.
    expect((row!.enrichmentSource as Record<string, string>).attributes).toBe('human');
  });

  it("refuses to update another merchant's product", async () => {
    const d = deps();
    const created = await createProduct(d, merchantId, {
      externalRef: 'OWNED-001',
      archetype: 'SIMPLE',
      name: 'Owned',
      attributes: {},
      images: [],
      optionAxes: [],
      variants: [{ sku: 'OWNED-001', optionValues: {}, price: '100', stock: 1, images: [] }],
    });

    // Scoped by merchant, and the error is the same NOT_FOUND a missing id gives — so one
    // merchant cannot probe for another's product ids by comparing responses.
    await expect(
      updateProduct(d, randomUUID(), created.productId, { name: 'Stolen' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('archives without deleting, so order history keeps its references', async () => {
    const d = deps();
    const created = await createProduct(d, merchantId, {
      externalRef: 'ARCH-001',
      archetype: 'SIMPLE',
      name: 'To Archive',
      attributes: {},
      images: [],
      optionAxes: [],
      variants: [{ sku: 'ARCH-001', optionValues: {}, price: '100', stock: 1, images: [] }],
    });

    await archiveProduct(d, merchantId, created.productId);

    const [row] = await db.select().from(products).where(eq(products.id, created.productId));
    expect(row!.status).toBe('archived');
    // Still there, and its variants with it.
    const variants = await db
      .select()
      .from(productVariants)
      .where(eq(productVariants.productId, created.productId));
    expect(variants.length).toBeGreaterThan(0);
  });

  it('puts a removed product back, and re-queues it so search sees it again', async () => {
    const d = deps();
    const created = await createProduct(d, merchantId, {
      externalRef: `restore-${randomUUID().slice(0, 8)}`,
      archetype: 'SIMPLE',
      name: 'Restorable Thing',
      attributes: {},
      images: [],
      optionAxes: [],
      variants: [{ sku: 'RES-001', optionValues: {}, price: '100', stock: 1, images: [] }],
    });

    await archiveProduct(d, merchantId, created.productId);
    const before = d.enrichmentQueue.messages.length;

    const restored = await restoreProduct(d, merchantId, created.productId);
    expect(restored.status).toBe('active');

    const [row] = await db.select().from(products).where(eq(products.id, created.productId));
    expect(row!.status).toBe('active');
    /**
     * The archive trigger left the units `pending`; nothing re-indexes them on its own, so
     * restoring has to enqueue or the product comes back in the dashboard and stays
     * invisible to buyers — the worst of both.
     */
    expect(d.enrichmentQueue.messages.length).toBe(before + 1);
  });

  it('refuses to restore something that was never removed', async () => {
    const d = deps();
    const created = await createProduct(d, merchantId, {
      externalRef: `live-${randomUUID().slice(0, 8)}`,
      archetype: 'SIMPLE',
      name: 'Live Thing',
      attributes: {},
      images: [],
      optionAxes: [],
      variants: [{ sku: 'LIV-001', optionValues: {}, price: '100', stock: 1, images: [] }],
    });

    // A draft flipped to active here would be published without ever being enriched.
    await expect(restoreProduct(d, merchantId, created.productId)).rejects.toThrow();
  });
});
