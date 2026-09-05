import { describe, expect, it } from 'vitest';
import { HttpCatalog } from './catalog.js';
import type { CatalogPort } from './port.js';

/**
 * The tools are tested through the catalogue adapter rather than through a live transport:
 * what matters is the shape a model receives, and the SDK's job of moving bytes is not ours
 * to re-verify.
 */
function catalogWith(responses: Record<string, unknown>): CatalogPort {
  return new HttpCatalog({
    apiBaseUrl: 'https://api.test',
    buyerAppUrl: 'https://buy.test',
    signedFetch: async (url) => {
      const path = new URL(url).pathname;
      return new Response(JSON.stringify(responses[path] ?? {}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
}

const RESULT = {
  id: 'unit-1',
  productId: 'prod-1',
  name: 'Oxford Cotton Shirt',
  brand: 'Meridian',
  displayPrice: '₹1,999',
  pricePaise: '199900',
  priceAsOf: '2026-09-05T10:00:00.000Z',
  availability: 'in_stock',
  deliveryEstimate: 'Arrives in 3 days',
  options: { size: '42', colour: 'white' },
  whyThisMatched: 'Cotton, size 42, ships in 3 days',
  merchant: {
    id: 'merch-1',
    name: 'Meridian Apparel',
    trust: { score: 0.87, newMerchant: false, signals: ['GSTIN verified'] },
  },
  imageUrl: 'https://img.test/1.jpg',
};

describe('search_products', () => {
  it('never returns more than five, whatever is asked for', async () => {
    // Rule 6, enforced past the schema: a model that ignores the default must still not
    // be able to ask for more.
    const many = Array.from({ length: 20 }, (_, i) => ({ ...RESULT, id: `unit-${i}` }));
    let sentLimit = 0;
    const catalog = new HttpCatalog({
      apiBaseUrl: 'https://api.test',
      buyerAppUrl: 'https://buy.test',
      signedFetch: async (_url, init) => {
        sentLimit = JSON.parse(String(init.body)).limit;
        return new Response(JSON.stringify({ results: many.slice(0, sentLimit) }), { status: 200 });
      },
    });

    const result = await catalog.search({ query: 'shirt', limit: 50 as never });
    expect(sentLimit).toBe(5);
    expect(result.results.length).toBeLessThanOrEqual(5);
  });

  it('stamps every result with when the price and stock were true', async () => {
    // Rule 7: no bare numbers. A model quoting a price without a time is asserting "now".
    const catalog = catalogWith({ '/internal/search': { results: [RESULT] } });
    const [result] = (await catalog.search({ query: 'shirt' })).results;

    expect(result!.price_as_of).toBe('2026-09-05T10:00:00.000Z');
    expect(result!.availability_as_of).toBe('2026-09-05T10:00:00.000Z');
  });

  it('passes the no-results reason through for the model to quote', async () => {
    // Rule 8. Without a sentence to state, a model explains the absence itself.
    const catalog = catalogWith({
      '/internal/search': {
        results: [],
        noResultsReason: 'Nothing under ₹2,000 delivers to 560001 within 4 days.',
      },
    });
    const result = await catalog.search({ query: 'shirt', max_price_inr: 2000 });

    expect(result.results).toEqual([]);
    expect(result.no_results_reason).toContain('Nothing under');
  });

  it('names the destination in a delivery estimate when it knows one', async () => {
    const catalog = catalogWith({ '/internal/search': { results: [RESULT] } });
    const [withPin] = (await catalog.search({ query: 'shirt', pincode: '560001' })).results;
    expect(withPin!.delivery_estimate).toBe('Arrives in 3 days to 560001');

    const [without] = (await catalog.search({ query: 'shirt' })).results;
    expect(without!.delivery_estimate).toBe('Arrives in 3 days');
  });

  it('returns both ids, because the tools chain on different ones', async () => {
    /**
     * Regression. Search returns the *variant* as `id` (D6), while `get_product` and
     * `compare_products` take a *product* id. Returning only one made every `get_product`
     * call after a search fail on a UUID that was real but was not a product.
     */
    const catalog = catalogWith({ '/internal/search': { results: [RESULT] } });
    const [result] = (await catalog.search({ query: 'shirt' })).results;
    expect(result!.id).toBe('unit-1');
    expect(result!.product_id).toBe('prod-1');
  });

  it('carries the merchant trust signals a buyer weighs', async () => {
    const catalog = catalogWith({ '/internal/search': { results: [RESULT] } });
    const [result] = (await catalog.search({ query: 'shirt' })).results;
    expect(result!.merchant.trust).toEqual({
      score: 0.87,
      new_merchant: false,
      signals: ['GSTIN verified'],
    });
  });

  it('treats a merchant with no trust data as new rather than trusted', async () => {
    // Defaulting to trusted would make a missing field look like a good record.
    const catalog = catalogWith({
      '/internal/search': { results: [{ ...RESULT, merchant: { id: 'm', name: 'X' } }] },
    });
    const [result] = (await catalog.search({ query: 'shirt' })).results;
    expect(result!.merchant.trust.new_merchant).toBe(true);
    expect(result!.merchant.trust.score).toBe(0);
  });
});

describe('compare_products', () => {
  const dashcams = {
    '/internal/product': {
      id: 'p1',
      name: 'RoadEye 4K',
      attributes: { resolution: '4K', night_vision: true, gps: true },
    },
  };

  it('returns explicit nulls where an item lacks a key', async () => {
    /**
     * An omitted key is ambiguous: a model cannot tell "no fabric recorded" from "I forgot
     * to mention fabric", and it will often guess. A null is a fact it can state.
     */
    let call = 0;
    const products = [
      { id: 'p1', name: 'RoadEye 4K', attributes: { resolution: '4K', gps: true } },
      { id: 'p2', name: 'RoadEye Mini', attributes: { resolution: '1080p' } },
    ];
    const catalog = new HttpCatalog({
      apiBaseUrl: 'https://api.test',
      buyerAppUrl: 'https://buy.test',
      signedFetch: async () =>
        new Response(JSON.stringify(products[call++ % products.length]), { status: 200 }),
    });

    const result = await catalog.compare({ product_ids: ['p1', 'p2'] });

    expect(result.attribute_keys).toEqual(['gps', 'resolution']);
    // Every item has every key, even the ones it does not have a value for.
    for (const item of result.items) {
      expect(Object.keys(item.attributes).sort()).toEqual(['gps', 'resolution']);
    }
    expect(result.items[1]!.attributes.gps).toBeNull();
  });

  it('names only the keys that actually diverge', async () => {
    // Without this the model recites the whole table and buries the one difference the
    // buyer is choosing on.
    let call = 0;
    const products = [
      { id: 'p1', name: 'A', attributes: { brand: 'RoadEye', resolution: '4K' } },
      { id: 'p2', name: 'B', attributes: { brand: 'RoadEye', resolution: '1080p' } },
    ];
    const catalog = new HttpCatalog({
      apiBaseUrl: 'https://api.test',
      buyerAppUrl: 'https://buy.test',
      signedFetch: async () =>
        new Response(JSON.stringify(products[call++ % products.length]), { status: 200 }),
    });

    const result = await catalog.compare({ product_ids: ['p1', 'p2'] });
    expect(result.differences).toEqual(['resolution']);
  });

  it('reports no differences when items genuinely match', async () => {
    const catalog = catalogWith(dashcams);
    const result = await catalog.compare({ product_ids: ['p1', 'p2'] });
    expect(result.differences).toEqual([]);
  });
});

describe('create_checkout', () => {
  it('returns a URL and creates no payment', async () => {
    /**
     * Creating a Razorpay order here would mean creating it before the buyer picks an
     * address — an orphaned payment object for everyone who changes their mind at that step.
     */
    const catalog = catalogWith({
      '/checkout/session': {
        sessionId: 'sess-1',
        token: 'tok-abc',
        expiresAt: '2026-09-05T11:00:00.000Z',
      },
    });

    const result = (await catalog.createCheckout({ product_id: 'p1', quantity: 1 })) as {
      checkout_url: string;
      session_id: string;
      note: string;
    };

    expect(result.checkout_url).toBe('https://buy.test/s?t=tok-abc');
    expect(result.session_id).toBe('sess-1');
    expect(result.note).toMatch(/pays this merchant directly/i);
  });
});
