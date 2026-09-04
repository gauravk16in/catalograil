import { expect, test } from '@playwright/test';

/**
 * Journey 5 — the buyer.
 *
 * The first assertion is the one that shapes the product: browsing needs no account. A buyer
 * who must sign up before they can look at anything will not sign up, and the same catalogue
 * is answered into Claude and ChatGPT where there is no login at all.
 */
const API = process.env.API_BASE_URL;
const BUYER_TOKEN = process.env.E2E_BUYER_ID_TOKEN;

test.describe('buyer', () => {
  test.skip(!API, 'Needs API_BASE_URL.');

  test('searches with no account at all', async ({ request }) => {
    const response = await request.post(`${API}/search`, {
      data: { query: 'cotton shirt', limit: 3 },
    });
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.results.length).toBeGreaterThan(0);
    // Rule 7 holds on the public surface too.
    for (const result of body.results) expect(result.priceAsOf).toBeTruthy();
  });

  test('returns distinct products, not one product repeatedly', async ({ request }) => {
    // Eleven of fifteen baseline queries used to return three variants of one product.
    const response = await request.post(`${API}/search`, {
      data: { query: 'shirt', limit: 5 },
    });
    const ids = (await response.json()).results.map((r: { productId: string }) => r.productId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('refuses anything personal without a token', async ({ request }) => {
    for (const path of ['/buyer/me', '/buyer/addresses', '/buyer/orders']) {
      const response = await request.get(`${API}${path}`);
      expect(response.status(), path).toBe(401);
    }
  });

  test.describe('signed in', () => {
    test.skip(!BUYER_TOKEN, 'Needs E2E_BUYER_ID_TOKEN.');

    const auth = () => ({ authorization: `Bearer ${BUYER_TOKEN}` });

    test('says what is still needed before checkout', async ({ request }) => {
      const response = await request.get(`${API}/buyer/me`, { headers: auth() });
      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty('checkoutReady');
      expect(Array.isArray(body.missing)).toBe(true);
    });

    test('rejects an address with an impossible PIN code', async ({ request }) => {
      const response = await request.post(`${API}/buyer/addresses`, {
        headers: auth(),
        data: {
          recipientName: 'X',
          recipientPhone: '+919876543210',
          line1: 'Y',
          city: 'Z',
          state: 'W',
          pincode: '012',
        },
      });
      expect(response.status()).toBe(400);
    });

    test('is refused on merchant routes', async ({ request }) => {
      // Separate pools: the merchant authorizer does not accept the buyer issuer at all.
      const response = await request.get(`${API}/merchant/products`, { headers: auth() });
      expect(response.status()).toBe(401);
    });
  });
});
