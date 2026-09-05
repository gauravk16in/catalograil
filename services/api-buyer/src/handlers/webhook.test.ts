import { createHmac, randomUUID } from 'node:crypto';
import { fixedClock } from '@catalograil/core';
import { InMemoryIdempotencyStore } from '@catalograil/aws';
import { ReversibleTestCipher } from '@catalograil/razorpay';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleRazorpayWebhook, type WebhookDeps } from './webhook.js';

const DATABASE_URL = process.env.DATABASE_URL;
const NOW = new Date('2026-09-05T12:00:00Z');
const WEBHOOK_SECRET = 'whsec_test_value';

describe.skipIf(!DATABASE_URL)('razorpay webhook', () => {
  let client: postgres.Sql;
  let db: PostgresJsDatabase;
  let merchantId: string;

  beforeAll(async () => {
    client = postgres(DATABASE_URL!, { max: 4, onnotice: () => {} });
    db = drizzle(client);
    merchantId = randomUUID();
    await client`
      INSERT INTO merchants (id, business_name, contact_email, status)
      VALUES (${merchantId}, 'Webhook Test', ${`wh-${merchantId}@example.com`}, 'active')`;
    await client`
      INSERT INTO merchant_payment_config (merchant_id, method, key_id, key_secret_encrypted,
        key_secret_last4, webhook_secret_encrypted, status, mode)
      VALUES (${merchantId}, 'api_keys', 'rzp_test_ABCDEFGHIJKL',
              ${'test:' + Buffer.from('s').toString('base64')}, '1234',
              ${'test:' + Buffer.from(WEBHOOK_SECRET).toString('base64')}, 'verified', 'test')`;
  });

  afterAll(async () => {
    if (merchantId) {
      await client`DELETE FROM order_events WHERE order_id IN (SELECT id FROM orders WHERE merchant_id = ${merchantId})`;
      await client`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE merchant_id = ${merchantId})`;
      await client`DELETE FROM orders WHERE merchant_id = ${merchantId}`;
      await client`DELETE FROM merchants WHERE id = ${merchantId}`;
    }
    await client?.end();
  });

  function deps(store = new InMemoryIdempotencyStore()): WebhookDeps {
    return {
      db: db as never,
      clock: fixedClock(NOW),
      cipherFor: () => new ReversibleTestCipher(),
      idempotency: store,
    };
  }

  async function makeOrder(razorpayOrderId: string, status = 'awaiting_payment'): Promise<string> {
    const [row] = await client<{ id: string }[]>`
      INSERT INTO orders (order_number, buyer_email, merchant_id, status,
                          subtotal_paise, shipping_paise, tax_paise, total_paise,
                          razorpay_order_id, source)
      VALUES (${'ORD-' + randomUUID().slice(0, 6).toUpperCase()}, 'b@example.com', ${merchantId},
              ${status}, 100000, 0, 0, 100000, ${razorpayOrderId}, 'claude')
      RETURNING id`;
    return row!.id;
  }

  function captured(razorpayOrderId: string, paymentId = `pay_${randomUUID().slice(0, 10)}`) {
    const body = JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { id: paymentId, order_id: razorpayOrderId, status: 'captured' } } },
    });
    const signature = createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
    return { body, signature };
  }

  it('marks an order paid on capture', async () => {
    const rzpId = `order_${randomUUID().slice(0, 10)}`;
    const orderId = await makeOrder(rzpId);
    const { body, signature } = captured(rzpId);

    const result = await handleRazorpayWebhook(deps(), merchantId, body, signature);
    expect(result).toMatchObject({ handled: true, orderId, status: 'paid' });
  });

  it('produces exactly one transition from five identical deliveries', async () => {
    /**
     * T2.16's acceptance. Razorpay retries, and a retry that ships a second stock decrement
     * or a second merchant notification is worse than a missed one.
     */
    const rzpId = `order_${randomUUID().slice(0, 10)}`;
    const orderId = await makeOrder(rzpId);
    const { body, signature } = captured(rzpId);
    const store = new InMemoryIdempotencyStore();

    const outcomes = [];
    for (let i = 0; i < 5; i++) {
      outcomes.push(await handleRazorpayWebhook(deps(store), merchantId, body, signature));
    }

    expect(outcomes.filter((o) => o.handled)).toHaveLength(1);
    const events = await client`
      SELECT event_type FROM order_events WHERE order_id = ${orderId} AND event_type = 'payment.paid'`;
    expect(events).toHaveLength(1);
  });

  it('rejects an unsigned request before reading the body', async () => {
    const rzpId = `order_${randomUUID().slice(0, 10)}`;
    await makeOrder(rzpId);
    const { body } = captured(rzpId);
    await expect(
      handleRazorpayWebhook(deps(), merchantId, body, undefined),
    ).rejects.toThrow(/signature/i);
  });

  it('rejects a forged signature', async () => {
    const rzpId = `order_${randomUUID().slice(0, 10)}`;
    await makeOrder(rzpId);
    const { body } = captured(rzpId);
    await expect(
      handleRazorpayWebhook(deps(), merchantId, body, 'a'.repeat(64)),
    ).rejects.toThrow(/did not verify/i);
  });

  it('will not let one merchant move another merchant’s order', async () => {
    /**
     * A valid signature proves who sent the request, not what they are entitled to touch.
     * Without the ownership check, a merchant could replay an event id naming someone
     * else's order.
     */
    const other = randomUUID();
    await client`
      INSERT INTO merchants (id, business_name, contact_email, status)
      VALUES (${other}, 'Other', ${`o-${other}@example.com`}, 'active')`;
    await client`
      INSERT INTO merchant_payment_config (merchant_id, method, key_id, key_secret_encrypted,
        key_secret_last4, webhook_secret_encrypted, status, mode)
      VALUES (${other}, 'api_keys', 'rzp_test_ZZZZZZZZZZZZ', ${'test:' + Buffer.from('s').toString('base64')},
              '9999', ${'test:' + Buffer.from(WEBHOOK_SECRET).toString('base64')}, 'verified', 'test')`;

    const rzpId = `order_${randomUUID().slice(0, 10)}`;
    await makeOrder(rzpId);
    const { body, signature } = captured(rzpId);

    try {
      await expect(
        handleRazorpayWebhook(deps(), other, body, signature),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    } finally {
      await client`DELETE FROM merchants WHERE id = ${other}`;
    }
  });

  it('releases stock when a payment fails', async () => {
    const rzpId = `order_${randomUUID().slice(0, 10)}`;
    const orderId = await makeOrder(rzpId);

    const [product] = await client<{ id: string }[]>`
      INSERT INTO products (merchant_id, archetype, name, status)
      VALUES (${merchantId}, 'SIMPLE', 'Webhook Product', 'active') RETURNING id`;
    const [variant] = await client<{ id: string }[]>`
      INSERT INTO product_variants (product_id, sku, option_values, price_paise, stock, status)
      VALUES (${product!.id}, ${'WH-' + randomUUID().slice(0, 6)}, '{}', 100000, 2, 'active')
      RETURNING id`;
    await client`
      INSERT INTO order_items (order_id, product_id, variant_id, name_snapshot, sku_snapshot,
                               unit_price_paise, quantity, line_total_paise)
      VALUES (${orderId}, ${product!.id}, ${variant!.id}, 'Webhook Product', 'WH', 100000, 2, 200000)`;

    const body = JSON.stringify({
      event: 'payment.failed',
      payload: { payment: { entity: { id: `pay_${randomUUID().slice(0, 8)}`, order_id: rzpId } } },
    });
    const signature = createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');

    await handleRazorpayWebhook(deps(), merchantId, body, signature);

    const [after] = await client`SELECT stock FROM product_variants WHERE id = ${variant!.id}`;
    expect(after!.stock).toBe(4);
  });

  it('ignores an event it does not handle without erroring', async () => {
    // Razorpay sends many event types; an unrecognised one is not a failure, and returning
    // non-2xx would make them retry it indefinitely.
    const rzpId = `order_${randomUUID().slice(0, 10)}`;
    await makeOrder(rzpId);
    const body = JSON.stringify({
      event: 'payment.authorized',
      payload: { payment: { entity: { id: `pay_${randomUUID().slice(0, 8)}`, order_id: rzpId } } },
    });
    const signature = createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');

    const result = await handleRazorpayWebhook(deps(), merchantId, body, signature);
    expect(result.handled).toBe(false);
    expect(result.reason).toMatch(/ignoring/i);
  });
});
