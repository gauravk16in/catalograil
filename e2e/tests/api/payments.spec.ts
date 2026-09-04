import { expect, test } from '@playwright/test';
import { apiRequest, readEnv } from '../../lib/auth.js';

/**
 * Block C's acceptance, minus the happy path.
 *
 * Connecting real credentials is not something a test suite should do to a shared
 * environment — it would leave working keys behind, or break a merchant who had them.
 * Everything up to that point is asserted here.
 */
const env = readEnv();

test.describe('payment config', () => {
  test.skip(!env, 'Needs API_BASE_URL and E2E merchant credentials.');

  test('never returns the secret', async () => {
    const response = await apiRequest(env!, '/merchant/payment-config');
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toMatch(/keySecretEncrypted|key_secret_encrypted/);
    expect(text).not.toMatch(/webhookSecretEncrypted/);
  });

  test('tells the merchant which URL to register', async () => {
    const body = await (await apiRequest(env!, '/merchant/payment-config')).json();
    expect(body.webhookUrl).toContain('/webhooks/razorpay/');
  });

  test('rejects a key that is not a Razorpay key', async () => {
    const response = await apiRequest(env!, '/merchant/payment-config', {
      method: 'POST',
      body: JSON.stringify({ keyId: 'sk_live_stripe_key', keySecret: 'nope' }),
    });
    expect(response.status).toBe(400);
  });

  test('refuses live keys outside production', async () => {
    // One test order against live keys is a real charge on a real card.
    test.skip(process.env.STAGE === 'prod', 'Live keys are legitimate in production.');
    const response = await apiRequest(env!, '/merchant/payment-config', {
      method: 'POST',
      body: JSON.stringify({ keyId: 'rzp_live_ABCDEFGHIJKL', keySecret: 'whatever' }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).message).toMatch(/live keys/i);
  });

  test('rejects credentials Razorpay refuses, and stores nothing', async () => {
    const before = await (await apiRequest(env!, '/merchant/payment-config')).text();

    const response = await apiRequest(env!, '/merchant/payment-config', {
      method: 'POST',
      body: JSON.stringify({ keyId: 'rzp_test_ABCDEFGHIJKL', keySecret: 'notarealsecret' }),
    });
    expect(response.status).toBe(403);

    // A typo must not flip a working merchant to invalid — search excludes unverified ones.
    const after = await (await apiRequest(env!, '/merchant/payment-config')).text();
    expect(after).toBe(before);
  });
});
