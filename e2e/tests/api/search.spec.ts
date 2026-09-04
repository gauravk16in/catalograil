import { expect, test } from '@playwright/test';
import { apiRequest, readEnv } from '../../lib/auth.js';

/**
 * Journey 3 — search correctness.
 *
 * The assertions that matter are the exclusions. A constraint that ranks lower instead of
 * excluding is how a buyer ends up shown something that cannot reach them in time.
 */
const env = readEnv();

async function search(body: Record<string, unknown>) {
  const response = await apiRequest(env!, '/merchant/search-preview', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return response;
}

test.describe('search', () => {
  test.skip(!env, 'Needs API_BASE_URL and E2E merchant credentials.');

  test('matches on meaning, not just words', async () => {
    /**
     * "record my drive" shares no keyword with "dashcam". This passing is the whole premise
     * of the product: a buyer describes a need and gets the product that meets it.
     */
    const response = await search({ query: 'something to record my drive', limit: 5 });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.results.length).toBeGreaterThan(0);
    const names = body.results.map((r: { name: string }) => r.name.toLowerCase()).join(' ');
    expect(names).toContain('dashcam');
  });

  test('never returns anything above the price ceiling', async () => {
    const response = await search({ query: 'shirt', filters: { maxPriceInr: 1500 }, limit: 20 });
    const body = await response.json();
    for (const result of body.results) {
      if (result.pricePaise) expect(Number(result.pricePaise)).toBeLessThanOrEqual(150000);
    }
  });

  test('excludes items that cannot arrive in time', async () => {
    // A hard exclusion, not a penalty: an item that cannot arrive must not appear because
    // it happens to be cheap.
    const response = await search({ query: 'shirt', filters: { maxDeliveryDays: 2 }, limit: 20 });
    const body = await response.json();
    for (const result of body.results) {
      if (result.deliveryEstimate) {
        const days = Number(/\d+/.exec(result.deliveryEstimate)?.[0] ?? '0');
        expect(days).toBeLessThanOrEqual(2);
      }
    }
  });

  test('gives a reason when nothing matches, so a model states a fact', async () => {
    // Rule 8. Without it the calling model invents an explanation.
    const response = await search({ query: 'zzqqxx nonexistent gibberish', limit: 5 });
    const body = await response.json();
    expect(body.results).toEqual([]);
    expect(body.noResultsReason).toBeTruthy();
  });

  test('stamps every price with when it was true', async () => {
    // Rule 7: no bare numbers.
    const response = await search({ query: 'shirt', limit: 5 });
    const body = await response.json();
    for (const result of body.results) expect(result.priceAsOf).toBeTruthy();
  });
});
