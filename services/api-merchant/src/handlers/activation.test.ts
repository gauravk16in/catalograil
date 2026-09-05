import { randomUUID } from 'node:crypto';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reconcileMerchantStatus } from './activation.js';

const DATABASE_URL = process.env.DATABASE_URL;
const NOW = new Date('2026-09-05T10:00:00Z');

describe.skipIf(!DATABASE_URL)('merchant activation', () => {
  let client: postgres.Sql;
  let db: PostgresJsDatabase;
  const created: string[] = [];

  beforeAll(() => {
    client = postgres(DATABASE_URL!, { max: 2, onnotice: () => {} });
    db = drizzle(client);
  });

  afterAll(async () => {
    for (const id of created) await client`DELETE FROM merchants WHERE id = ${id}`;
    await client?.end();
  });

  async function merchant(status = 'pending'): Promise<string> {
    const id = randomUUID();
    created.push(id);
    await client`
      INSERT INTO merchants (id, business_name, contact_email, status)
      VALUES (${id}, 'Activation Test', ${`act-${id}@example.com`}, ${status})`;
    return id;
  }

  async function acceptPolicies(id: string): Promise<void> {
    await client`
      INSERT INTO merchant_policies (merchant_id, refund_url, terms_url, fulfillment_url,
                                     last_check_status, last_checked_at)
      VALUES (${id}, 'https://e.com/r', 'https://e.com/t', 'https://e.com/f', 'ok', now())`;
  }

  async function verifyPayment(id: string): Promise<void> {
    await client`
      INSERT INTO merchant_payment_config (merchant_id, method, key_id, status, mode)
      VALUES (${id}, 'api_keys', 'rzp_test_ABCDEFGHIJKL', 'verified', 'test')`;
  }

  it('will not activate on policies alone', async () => {
    /**
     * The regression. Policies used to activate outright, which was right when Razorpay
     * OAuth was step one. DC1 and DC2 made them independent, so a merchant could accept
     * policies with no payment connection and go live — where a buyer picks a product and
     * then cannot pay for it.
     */
    const id = await merchant();
    await acceptPolicies(id);

    const state = await reconcileMerchantStatus(db as never, id, NOW);
    expect(state.status).toBe('pending');
    expect(state.blockers).toEqual(['a verified Razorpay connection']);
  });

  it('will not activate on payment alone', async () => {
    // Rule 4: without policies on file there is no contract to show a buyer who returns.
    const id = await merchant();
    await verifyPayment(id);

    const state = await reconcileMerchantStatus(db as never, id, NOW);
    expect(state.status).toBe('pending');
    expect(state.blockers).toEqual(['your refund, terms and fulfillment URLs']);
  });

  it('activates once both gates are clear, in either order', async () => {
    // The two are cleared on different screens, so whichever is second must be what flips
    // them live — otherwise the merchant who did them the "wrong" way stays pending forever.
    const policiesFirst = await merchant();
    await acceptPolicies(policiesFirst);
    await reconcileMerchantStatus(db as never, policiesFirst, NOW);
    await verifyPayment(policiesFirst);
    expect((await reconcileMerchantStatus(db as never, policiesFirst, NOW)).status).toBe('active');

    const paymentFirst = await merchant();
    await verifyPayment(paymentFirst);
    await reconcileMerchantStatus(db as never, paymentFirst, NOW);
    await acceptPolicies(paymentFirst);
    expect((await reconcileMerchantStatus(db as never, paymentFirst, NOW)).status).toBe('active');
  });

  it('propagates activation into search', async () => {
    // The status write is only meaningful because the T1.16 trigger carries it into
    // searchable_units, which is what every search filters on.
    const id = await merchant();
    await acceptPolicies(id);
    await verifyPayment(id);

    const [product] = await client<{ id: string }[]>`
      INSERT INTO products (merchant_id, archetype, name, status)
      VALUES (${id}, 'SIMPLE', 'Activation Product', 'active') RETURNING id`;
    await client`
      INSERT INTO searchable_units
        (unit_type, product_id, merchant_id, archetype, canonical_text, content_hash,
         embedding_status, merchant_status)
      VALUES ('product', ${product!.id}, ${id}, 'SIMPLE', 'x', ${randomUUID()}, 'indexed', 'pending')`;

    await reconcileMerchantStatus(db as never, id, NOW);

    const rows = await client`SELECT merchant_status FROM searchable_units WHERE merchant_id = ${id}`;
    expect(rows[0]!.merchant_status).toBe('active');
  });

  it('never resurrects a suspended merchant', async () => {
    /**
     * Suspension is an administrative decision, not a state a merchant clears by filling in
     * a form. Reconciling it here would let a suspended merchant restore themselves by
     * re-submitting a policy URL.
     */
    const id = await merchant('suspended');
    await acceptPolicies(id);
    await verifyPayment(id);

    expect((await reconcileMerchantStatus(db as never, id, NOW)).status).toBe('suspended');
  });

  it('drops a merchant back to pending when a gate stops holding', async () => {
    const id = await merchant();
    await acceptPolicies(id);
    await verifyPayment(id);
    expect((await reconcileMerchantStatus(db as never, id, NOW)).status).toBe('active');

    await client`DELETE FROM merchant_payment_config WHERE merchant_id = ${id}`;
    expect((await reconcileMerchantStatus(db as never, id, NOW)).status).toBe('pending');
  });
});
