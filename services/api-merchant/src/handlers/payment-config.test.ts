import { randomUUID } from 'node:crypto';
import { fixedClock } from '@catalograil/core';
import { ReversibleTestCipher } from '@catalograil/razorpay';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  connectPaymentConfig,
  disconnectPaymentConfig,
  readPaymentConfig,
  testWebhook,
  webhookUrlFor,
  type PaymentConfigDeps,
} from './payment-config.js';

const DATABASE_URL = process.env.DATABASE_URL;
const NOW = new Date('2026-09-05T10:00:00Z');
const SECRET = 'supersecretvalue4417';

describe.skipIf(!DATABASE_URL)('payment config', () => {
  let client: postgres.Sql;
  let db: PostgresJsDatabase;
  let merchantId: string;

  beforeAll(async () => {
    client = postgres(DATABASE_URL!, { max: 2, onnotice: () => {} });
    db = drizzle(client);
    merchantId = randomUUID();
    await client`
      INSERT INTO merchants (id, business_name, contact_email, status)
      VALUES (${merchantId}, 'Pay Test', ${`pay-${merchantId}@example.com`}, 'active')`;
  });

  afterAll(async () => {
    if (merchantId) await client`DELETE FROM merchants WHERE id = ${merchantId}`;
    await client?.end();
  });

  /** Stands in for Razorpay so no test reaches the network. */
  function fetcher(status: number): typeof fetch {
    return (async () => new Response(status === 200 ? '{"items":[]}' : '{}', { status })) as never;
  }

  function deps(status = 200, stage = 'dev'): PaymentConfigDeps {
    return {
      db: db as never,
      cipherFor: () => new ReversibleTestCipher(),
      clock: fixedClock(NOW),
      fetcher: fetcher(status),
      stage,
    };
  }

  it('verifies against Razorpay before storing anything', async () => {
    const summary = await connectPaymentConfig(deps(), merchantId, {
      keyId: 'rzp_test_ABCDEFGHIJKL',
      keySecret: SECRET,
      webhookSecret: 'whsec_abcdef',
    });
    expect(summary.status).toBe('verified');
    expect(summary.mode).toBe('test');
  });

  it('never returns the secret, only its last four characters', async () => {
    /**
     * The rule that matters most in this file. A dashboard shows `rzp_live_••••4417`, and
     * the plaintext exists in exactly one place: memory, inside one invocation.
     */
    const summary = await readPaymentConfig(db as never, merchantId);
    const serialised = JSON.stringify(summary);
    expect(serialised).not.toContain(SECRET);
    expect(serialised).not.toContain('whsec_abcdef');
    expect(serialised).not.toMatch(/key_secret_encrypted|keySecretEncrypted/);
    expect((summary as { keySecretLast4: string }).keySecretLast4).toBe('4417');
  });

  it('reports that a webhook secret exists without revealing it', async () => {
    const summary = (await readPaymentConfig(db as never, merchantId)) as {
      webhookConfigured: boolean;
    };
    expect(summary.webhookConfigured).toBe(true);
  });

  it('rejects credentials Razorpay refuses, and writes nothing', async () => {
    const before = await readPaymentConfig(db as never, merchantId);
    await expect(
      connectPaymentConfig(deps(401), merchantId, {
        keyId: 'rzp_test_WRONGKEYVALUE',
        keySecret: 'nope',
      }),
    ).rejects.toMatchObject({ code: 'PAYMENT_CONFIG_INVALID' });

    // A typo must not flip a working merchant to invalid — search excludes unverified ones.
    expect(await readPaymentConfig(db as never, merchantId)).toEqual(before);
  });

  it('rejects a malformed key id without calling Razorpay', async () => {
    await expect(
      connectPaymentConfig(deps(), merchantId, { keyId: 'sk_live_stripe', keySecret: 'x' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses live keys outside production', async () => {
    // One test order against live keys is a real charge on a real card.
    await expect(
      connectPaymentConfig(deps(200, 'dev'), merchantId, {
        keyId: 'rzp_live_ABCDEFGHIJKL',
        keySecret: SECRET,
      }),
    ).rejects.toThrow(/live keys and this is the dev environment/i);
  });

  it('verifies the stored webhook secret round-trips', async () => {
    const result = await testWebhook(deps(), merchantId);
    expect(result.ok).toBe(true);
  });

  it('suspends the merchant on disconnect, so search drops them', async () => {
    const result = await disconnectPaymentConfig(deps(), merchantId);
    expect(result.merchantStatus).toBe('pending');
    expect(await readPaymentConfig(db as never, merchantId)).toEqual({ status: 'not_connected' });
  });

  it('removes the merchant from search when payment is disconnected (rule 15)', async () => {
    /**
     * The chain this asserts: disconnect suspends the merchant, and the T1.16 trigger
     * propagates that into `searchable_units.merchant_status`, which every search filters
     * on. A buyer who reaches checkout and cannot pay has had a worse experience than one
     * who never saw the product — so the exclusion has to be real, not intended.
     */
    const seller = randomUUID();
    await client`
      INSERT INTO merchants (id, business_name, contact_email, status)
      VALUES (${seller}, 'Rule 15', ${`r15-${seller}@example.com`}, 'active')`;
    const [product] = await client<{ id: string }[]>`
      INSERT INTO products (merchant_id, archetype, name, status)
      VALUES (${seller}, 'SIMPLE', 'Rule 15 Product', 'active') RETURNING id`;
    await client`
      INSERT INTO searchable_units
        (unit_type, product_id, merchant_id, archetype, canonical_text, content_hash,
         embedding_status, merchant_status)
      VALUES ('product', ${product!.id}, ${seller}, 'SIMPLE', 'rule 15', ${randomUUID()},
              'indexed', 'active')`;

    try {
      const visible = await client`
        SELECT merchant_status FROM searchable_units WHERE merchant_id = ${seller}`;
      expect(visible[0]!.merchant_status).toBe('active');

      await disconnectPaymentConfig(deps(), seller);

      const after = await client`
        SELECT merchant_status FROM searchable_units WHERE merchant_id = ${seller}`;
      // Search filters on merchant_status = 'active', so this is the exclusion.
      expect(after[0]!.merchant_status).toBe('pending');
    } finally {
      await client`DELETE FROM merchants WHERE id = ${seller}`;
    }
  });

  it('builds the webhook URL a merchant registers', () => {
    expect(webhookUrlFor('https://api.example.com/', 'm-1')).toBe(
      'https://api.example.com/webhooks/razorpay/m-1',
    );
  });
});
