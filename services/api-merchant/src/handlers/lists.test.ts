import { randomUUID } from 'node:crypto';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listProducts, type ServingState } from './lists.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('listProducts', () => {
  let client: postgres.Sql;
  let db: PostgresJsDatabase;
  let merchantId: string;

  beforeAll(async () => {
    client = postgres(DATABASE_URL!, { max: 2, onnotice: () => {} });
    db = drizzle(client);
    merchantId = randomUUID();
    await client`
      INSERT INTO merchants (id, business_name, contact_email, status)
      VALUES (${merchantId}, 'List Test Merchant', 'lists@example.com', 'active')`;
  });

  afterAll(async () => {
    if (merchantId) await client`DELETE FROM merchants WHERE id = ${merchantId}`;
    await client?.end();
  });

  async function makeProduct(name: string, status: string): Promise<string> {
    const [row] = await client<{ id: string }[]>`
      INSERT INTO products (merchant_id, archetype, name, status)
      VALUES (${merchantId}, 'SIMPLE', ${name}, ${status})
      RETURNING id`;
    return row!.id;
  }

  async function addUnit(productId: string, embeddingStatus: string): Promise<void> {
    await client`
      INSERT INTO searchable_units
        (unit_type, product_id, merchant_id, archetype, canonical_text, content_hash,
         embedding_status, merchant_status)
      VALUES ('product', ${productId}, ${merchantId}, 'SIMPLE', ${'text ' + productId},
              ${randomUUID()}, ${embeddingStatus}, 'active')`;
  }

  async function stateOf(productId: string): Promise<ServingState | undefined> {
    const { products } = await listProducts(db as never, merchantId, { limit: 100 });
    return products.find((p) => p.id === productId)?.servingState;
  }

  /**
   * Regression, and the reason this file exists.
   *
   * The counts came from correlated subqueries built by interpolating Drizzle columns.
   * Drizzle renders those unqualified, so `WHERE ${searchableUnits.productId} = ${products.id}`
   * became `WHERE "product_id" = "id"` — and inside the subquery `"id"` is the unit's own
   * id. It compared a unit id to a product id, matched nothing, and reported every product
   * as still processing. A merchant with a fully live catalogue would have been told it was
   * not ready, and nothing would have errored.
   */
  it('counts units that actually belong to the product', async () => {
    const id = await makeProduct('Counted Product', 'active');
    await addUnit(id, 'indexed');
    await addUnit(id, 'indexed');

    const { products } = await listProducts(db as never, merchantId, { limit: 100 });
    const row = products.find((p) => p.id === id);

    expect(row?.unitsTotal).toBe(2);
    expect(row?.unitsIndexed).toBe(2);
    expect(row?.servingState).toBe('indexed');
  });

  it('does not count another product\'s units', async () => {
    const mine = await makeProduct('Mine', 'active');
    const other = await makeProduct('Other', 'active');
    await addUnit(other, 'indexed');

    const { products } = await listProducts(db as never, merchantId, { limit: 100 });
    expect(products.find((p) => p.id === mine)?.unitsTotal).toBe(0);
  });

  it('reports partial when only some units are indexed', async () => {
    const id = await makeProduct('Half Indexed', 'active');
    await addUnit(id, 'indexed');
    await addUnit(id, 'pending');
    expect(await stateOf(id)).toBe('partial');
  });

  it('reports failed when every unit failed', async () => {
    const id = await makeProduct('All Failed', 'active');
    await addUnit(id, 'failed');
    expect(await stateOf(id)).toBe('failed');
  });

  it('distinguishes a draft from a product still being indexed', async () => {
    // Both have no indexed units, and they mean different things to a merchant: one is
    // waiting on them, the other on us.
    const draft = await makeProduct('Never Published', 'draft');
    const processing = await makeProduct('Published Not Indexed', 'active');
    expect(await stateOf(draft)).toBe('draft');
    expect(await stateOf(processing)).toBe('processing');
  });

  it('scopes to the caller, never returning another merchant\'s products', async () => {
    const stranger = randomUUID();
    await client`
      INSERT INTO merchants (id, business_name, contact_email, status)
      VALUES (${stranger}, 'Stranger', 'stranger@example.com', 'active')`;
    try {
      const { products } = await listProducts(db as never, stranger, { limit: 100 });
      expect(products).toHaveLength(0);
    } finally {
      await client`DELETE FROM merchants WHERE id = ${stranger}`;
    }
  });
});
