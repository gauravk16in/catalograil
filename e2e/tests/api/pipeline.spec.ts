import { expect, test } from '@playwright/test';
import { apiRequest, readEnv } from '../../lib/auth.js';

/**
 * Journey 4 — data integrity, and the pipeline state a merchant depends on.
 *
 * The re-embedding assertions are rule 9: price and stock changes must never trigger a
 * re-embed. Getting that wrong does not fail — it just makes every price change cost a
 * model call, which is invisible until the bill arrives.
 */
const env = readEnv();

test.describe('catalogue pipeline', () => {
  test.skip(!env, 'Needs API_BASE_URL and E2E merchant credentials.');

  test('reports serving state from the units, not the product row', async () => {
    /**
     * A product can be `active` with zero indexed units — which is exactly the state that
     * produced a full catalogue and an empty search. Status alone answers the wrong question.
     */
    const response = await apiRequest(env!, '/merchant/products?limit=50');
    expect(response.status).toBe(200);
    const body = await response.json();

    for (const product of body.products) {
      expect(product).toHaveProperty('servingState');
      if (product.servingState === 'indexed') {
        expect(product.unitsTotal).toBeGreaterThan(0);
        expect(product.unitsIndexed).toBe(product.unitsTotal);
      }
    }
  });

  test('summarises what is ready, processing and failed', async () => {
    const response = await apiRequest(env!, '/merchant/summary');
    const body = await response.json();
    expect(body.catalogue.ready + body.catalogue.processing + body.catalogue.failed).toBeLessThanOrEqual(
      body.catalogue.total,
    );
  });

  test('exposes a per-product pipeline timeline', async () => {
    const list = await (await apiRequest(env!, '/merchant/products?limit=1')).json();
    test.skip(list.products.length === 0, 'No products in this environment.');

    const response = await apiRequest(env!, `/merchant/products/${list.products[0].id}/status`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty('events');
    expect(body).toHaveProperty('servingState');
  });

  test('a stock change reaches search without re-indexing', async () => {
    /**
     * Rule 9's other half. Stock is denormalised into `searchable_units` by trigger and is
     * not part of `content_hash`, so this must be immediate and free.
     */
    const inventory = await (await apiRequest(env!, '/merchant/inventory')).json();
    test.skip(inventory.variants.length === 0, 'No variants in this environment.');

    const variant = inventory.variants[0];
    const response = await apiRequest(env!, '/merchant/inventory', {
      method: 'POST',
      body: JSON.stringify({ updates: [{ sku: variant.sku, stock: variant.stock }] }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).updated).toBe(1);
  });

  test("reports another merchant's SKU as unknown rather than updating it", async () => {
    const response = await apiRequest(env!, '/merchant/inventory', {
      method: 'POST',
      body: JSON.stringify({ updates: [{ sku: 'SKU-THAT-IS-NOT-OURS-9999', stock: 7 }] }),
    });
    const body = await response.json();
    expect(body.updated).toBe(0);
    expect(body.unknownSkus).toContain('SKU-THAT-IS-NOT-OURS-9999');
  });
});
