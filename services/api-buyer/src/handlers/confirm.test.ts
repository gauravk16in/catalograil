import { createHmac, randomUUID } from 'node:crypto';
import { fixedClock } from '@catalograil/core';
import { ReversibleTestCipher } from '@catalograil/razorpay';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { confirmPayment, type ConfirmDeps } from './confirm.js';

const DATABASE_URL = process.env.DATABASE_URL;
const NOW = new Date('2026-09-05T12:00:00Z');
const KEY_SECRET = 'razorpaytestsecret9876';

describe.skipIf(!DATABASE_URL)('payment confirmation', () => {
  let client: postgres.Sql;
  let db: PostgresJsDatabase;
  let merchantId: string;

  beforeAll(async () => {
    client = postgres(DATABASE_URL!, { max: 4, onnotice: () => {} });
    db = drizzle(client);
    merchantId = randomUUID();
    await client`
      INSERT INTO merchants (id, business_name, contact_email, status)
      VALUES (${merchantId}, 'Confirm Test', ${`cf-${merchantId}@example.com`}, 'active')`;
    await client`
      INSERT INTO merchant_payment_config (merchant_id, method, key_id, key_secret_encrypted,
        key_secret_last4, status, mode)
      VALUES (${merchantId}, 'api_keys', 'rzp_test_ABCDEFGHIJKL',
              ${'test:' + Buffer.from(KEY_SECRET).toString('base64')}, '9876', 'verified', 'test')`;
  });

  afterAll(async () => {
    if (merchantId) {
      await client`DELETE FROM order_events WHERE order_id IN (SELECT id FROM orders WHERE merchant_id = ${merchantId})`;
      await client`DELETE FROM orders WHERE merchant_id = ${merchantId}`;
      await client`DELETE FROM merchants WHERE id = ${merchantId}`;
    }
    await client?.end();
  });

  const deps = (): ConfirmDeps => ({
    db: db as never,
    clock: fixedClock(NOW),
    cipherFor: () => new ReversibleTestCipher(),
  });

  async function makeOrder(rzpOrderId: string, status = 'awaiting_payment'): Promise<string> {
    const [row] = await client<{ id: string }[]>`
      INSERT INTO orders (order_number, buyer_email, merchant_id, status,
                          subtotal_paise, shipping_paise, tax_paise, total_paise,
                          razorpay_order_id, source)
      VALUES (${'ORD-' + randomUUID().slice(0, 6).toUpperCase()}, 'b@example.com', ${merchantId},
              ${status}, 100000, 0, 0, 100000, ${rzpOrderId}, 'web')
      RETURNING id`;
    return row!.id;
  }

  /** Razorpay signs `order_id|payment_id` with the key secret. */
  const sign = (orderId: string, paymentId: string) =>
    createHmac('sha256', KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');

  it('marks an order paid when the signature verifies', async () => {
    const rzp = `order_${randomUUID().slice(0, 10)}`;
    const pay = `pay_${randomUUID().slice(0, 10)}`;
    const orderId = await makeOrder(rzp);

    const result = await confirmPayment(deps(), {
      orderId,
      razorpayOrderId: rzp,
      razorpayPaymentId: pay,
      razorpaySignature: sign(rzp, pay),
    });

    expect(result.status).toBe('paid');
    const [row] = await client`SELECT status, razorpay_payment_id FROM orders WHERE id = ${orderId}`;
    // The merchant dashboard shows this, and it is what makes "paid into your account"
    // checkable rather than a claim.
    expect(row!.razorpay_payment_id).toBe(pay);
  });

  it('refuses a forged signature', async () => {
    /**
     * The entire security of the browser path. The callback arrives from the buyer's own
     * browser — without this, anyone who knew an order id could mark it paid.
     */
    const rzp = `order_${randomUUID().slice(0, 10)}`;
    const orderId = await makeOrder(rzp);

    await expect(
      confirmPayment(deps(), {
        orderId,
        razorpayOrderId: rzp,
        razorpayPaymentId: 'pay_forged',
        razorpaySignature: 'f'.repeat(64),
      }),
    ).rejects.toThrow(/did not verify/i);

    const [row] = await client`SELECT status FROM orders WHERE id = ${orderId}`;
    expect(row!.status).toBe('awaiting_payment');
  });

  it('refuses a signature from a different order', async () => {
    // Replaying a real signature against someone else's order.
    const mine = `order_${randomUUID().slice(0, 10)}`;
    const other = `order_${randomUUID().slice(0, 10)}`;
    const pay = `pay_${randomUUID().slice(0, 10)}`;
    const orderId = await makeOrder(mine);

    await expect(
      confirmPayment(deps(), {
        orderId,
        razorpayOrderId: other,
        razorpayPaymentId: pay,
        razorpaySignature: sign(other, pay),
      }),
    ).rejects.toThrow(/different order/i);
  });

  it('is a no-op when the webhook got there first', async () => {
    /**
     * Both paths write the same transition and whichever arrives first wins. A second
     * confirmation must not produce a second `payment.paid` event — the history is what a
     * dispute is settled with.
     */
    const rzp = `order_${randomUUID().slice(0, 10)}`;
    const pay = `pay_${randomUUID().slice(0, 10)}`;
    const orderId = await makeOrder(rzp, 'paid');

    const result = await confirmPayment(deps(), {
      orderId,
      razorpayOrderId: rzp,
      razorpayPaymentId: pay,
      razorpaySignature: sign(rzp, pay),
    });

    expect(result.alreadyConfirmed).toBe(true);
    const events = await client`
      SELECT count(*)::int AS n FROM order_events WHERE order_id = ${orderId} AND event_type = 'payment.paid'`;
    expect(events[0]!.n).toBe(0);
  });

  it('does not resurrect an order that has already shipped', async () => {
    // A late browser callback must not walk a shipped order backwards to `paid`.
    const rzp = `order_${randomUUID().slice(0, 10)}`;
    const pay = `pay_${randomUUID().slice(0, 10)}`;
    const orderId = await makeOrder(rzp, 'shipped');

    const result = await confirmPayment(deps(), {
      orderId,
      razorpayOrderId: rzp,
      razorpayPaymentId: pay,
      razorpaySignature: sign(rzp, pay),
    });
    expect(result.status).toBe('shipped');
  });
});
