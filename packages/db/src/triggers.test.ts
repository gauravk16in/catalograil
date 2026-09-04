import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * T1.16 — the denormalisation triggers.
 *
 * These can only be tested against a real Postgres, because the thing under test *is* the
 * database: a mock would be asserting that the test's own idea of a trigger works.
 *
 * The acceptance criteria are stated in seconds ("within 1 second"), and triggers beat that
 * by being inside the writing transaction rather than merely fast — by the time the
 * merchant's UPDATE returns, search already agrees. The tests assert the stronger property
 * that holds: the change is visible immediately after commit, with no waiting at all.
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('denormalisation triggers', () => {
  let sql: postgres.Sql;
  let merchantId: string;
  let productId: string;
  let variantId: string;
  let unitId: string;

  beforeAll(async () => {
    sql = postgres(DATABASE_URL!, { max: 2, onnotice: () => {} });

    merchantId = randomUUID();
    await sql`
      INSERT INTO merchants (id, business_name, contact_email, status)
      VALUES (${merchantId}, 'Trigger Test Merchant', 'trigger@example.com', 'active')`;

    const [product] = await sql`
      INSERT INTO products (merchant_id, external_ref, archetype, name, status)
      VALUES (${merchantId}, 'TRIG-001', 'VARIANT', 'Trigger Test Shirt', 'active')
      RETURNING id`;
    productId = product!.id as string;

    const [variant] = await sql`
      INSERT INTO product_variants (product_id, sku, option_values, price_paise, stock, delivery_days)
      VALUES (${productId}, 'TRIG-001-M', '{"size":"M"}'::jsonb, 199900, 5, 3)
      RETURNING id`;
    variantId = variant!.id as string;

    // Written the way the embedding worker writes it, so the triggers act on a realistic row.
    const [unit] = await sql`
      INSERT INTO searchable_units
        (unit_type, product_id, variant_id, merchant_id, archetype, merchant_status,
         canonical_text, content_hash, embedding_status, in_stock, price_paise, delivery_days)
      VALUES
        ('variant', ${productId}, ${variantId}, ${merchantId}, 'VARIANT', 'active',
         'Trigger Test Shirt', 'hash-trig-001', 'indexed', TRUE, 199900, 3)
      RETURNING id`;
    unitId = unit!.id as string;
  });

  afterAll(async () => {
    if (merchantId) await sql`DELETE FROM merchants WHERE id = ${merchantId}`;
    await sql?.end();
  });

  async function unit() {
    const [row] = await sql`
      SELECT in_stock, price_paise, delivery_days, merchant_status, embedding_status, content_hash
      FROM searchable_units WHERE id = ${unitId}`;
    return row!;
  }

  // ── Acceptance: stock → 0 leaves in-stock results immediately ────────────────

  it('drops a unit out of in-stock results the moment stock hits zero', async () => {
    expect((await unit()).in_stock).toBe(true);

    await sql`UPDATE product_variants SET stock = 0 WHERE id = ${variantId}`;

    // No polling and no sleep: the trigger ran inside the UPDATE's transaction.
    expect((await unit()).in_stock).toBe(false);
  });

  it('brings it back when stock returns', async () => {
    await sql`UPDATE product_variants SET stock = 7 WHERE id = ${variantId}`;
    expect((await unit()).in_stock).toBe(true);
  });

  it('treats an archived variant as out of stock even with stock on hand', async () => {
    await sql`UPDATE product_variants SET status = 'archived' WHERE id = ${variantId}`;
    expect((await unit()).in_stock).toBe(false);

    await sql`UPDATE product_variants SET status = 'active' WHERE id = ${variantId}`;
    expect((await unit()).in_stock).toBe(true);
  });

  it('syncs a price change without touching the content hash (rule 9)', async () => {
    const before = await unit();

    await sql`UPDATE product_variants SET price_paise = 249900 WHERE id = ${variantId}`;

    const after = await unit();
    // postgres.js hands bigint columns back as strings; compared as such rather than
    // coerced, so the test cannot mask a precision problem it is meant to catch.
    expect(String(after.price_paise)).toBe('249900');
    // The critical half: a repricing must not look like a content change, or every price
    // edit would trigger a re-embed and rule 9's cost control would be dead.
    expect(after.content_hash).toBe(before.content_hash);
  });

  it('syncs a delivery change', async () => {
    await sql`UPDATE product_variants SET delivery_days = 9 WHERE id = ${variantId}`;
    expect((await unit()).delivery_days).toBe(9);
  });

  // ── Acceptance: suspending a merchant removes their catalogue immediately ────

  it('removes a suspended merchant from search at once', async () => {
    await sql`UPDATE merchants SET status = 'suspended' WHERE id = ${merchantId}`;

    // The search query filters on merchant_status = 'active'; this is what excludes them.
    expect((await unit()).merchant_status).toBe('suspended');
  });

  it('restores them on reactivation', async () => {
    await sql`UPDATE merchants SET status = 'active' WHERE id = ${merchantId}`;
    expect((await unit()).merchant_status).toBe('active');
  });

  it('propagates a trust score recomputation', async () => {
    await sql`
      INSERT INTO merchant_metrics (merchant_id, trust_score, is_new_merchant)
      VALUES (${merchantId}, 0.755, FALSE)
      ON CONFLICT (merchant_id) DO UPDATE SET trust_score = EXCLUDED.trust_score`;

    const [row] = await sql`SELECT trust_score FROM searchable_units WHERE id = ${unitId}`;
    expect(Number(row!.trust_score)).toBeCloseTo(0.755, 3);
  });

  it('takes an archived product out of the indexed set', async () => {
    await sql`UPDATE products SET status = 'archived' WHERE id = ${productId}`;
    expect((await unit()).embedding_status).toBe('pending');

    await sql`UPDATE products SET status = 'active' WHERE id = ${productId}`;
  });

  /**
   * The trigger fires only when a filterable actually changed. Without that guard the
   * embedding worker's own writes to searchable_units would cascade back into the variant
   * and round again.
   */
  it('does not fire when an unrelated column changes', async () => {
    const before = await unit();
    await sql`UPDATE product_variants SET weight_grams = 321 WHERE id = ${variantId}`;
    const after = await unit();
    expect(String(after.price_paise)).toBe(String(before.price_paise));
    expect(after.in_stock).toBe(before.in_stock);
  });
});
