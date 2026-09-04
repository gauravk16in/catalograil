import { randomUUID } from 'node:crypto';
import { fixedClock } from '@catalograil/core';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getOrder, listOrders, orderSummary, transitionOrder } from './orders.js';

const DATABASE_URL = process.env.DATABASE_URL;
const NOW = new Date('2026-09-05T12:00:00Z');

describe.skipIf(!DATABASE_URL)('order lifecycle', () => {
  let client: postgres.Sql;
  let db: PostgresJsDatabase;
  let merchantId: string;

  beforeAll(async () => {
    client = postgres(DATABASE_URL!, { max: 2, onnotice: () => {} });
    db = drizzle(client);
    merchantId = randomUUID();
    await client`
      INSERT INTO merchants (id, business_name, contact_email, status)
      VALUES (${merchantId}, 'Order Test', ${`ord-${merchantId}@example.com`}, 'active')`;
  });

  afterAll(async () => {
    /**
     * Orders first, deliberately.
     *
     * `orders.merchant_id` has no ON DELETE CASCADE, and that is correct: a buyer's order
     * history must not disappear because a merchant row was removed. So the teardown has to
     * unwind in order rather than the constraint being loosened to make a test tidier.
     */
    if (merchantId) {
      await client`DELETE FROM order_events WHERE order_id IN (
        SELECT id FROM orders WHERE merchant_id = ${merchantId})`;
      await client`DELETE FROM orders WHERE merchant_id = ${merchantId}`;
      await client`DELETE FROM merchants WHERE id = ${merchantId}`;
    }
    await client?.end();
  });

  const deps = () => ({ db: db as never, clock: fixedClock(NOW) });

  async function makeOrder(status: string): Promise<string> {
    const [row] = await client<{ id: string }[]>`
      INSERT INTO orders (order_number, buyer_email, merchant_id, status,
                          subtotal_paise, shipping_paise, tax_paise, total_paise, source)
      VALUES (${'ORD-' + randomUUID().slice(0, 6)}, 'buyer@example.com', ${merchantId},
              ${status}, 189900, 0, 0, 189900, 'claude')
      RETURNING id`;
    return row!.id;
  }

  it('moves an order through its lifecycle and records every step', async () => {
    const id = await makeOrder('paid');

    await transitionOrder(deps(), merchantId, id, { status: 'confirmed' });
    await transitionOrder(deps(), merchantId, id, { status: 'packed' });
    await transitionOrder(deps(), merchantId, id, {
      status: 'shipped',
      courier: 'Delhivery',
      awb: 'AWB123456',
    });
    await transitionOrder(deps(), merchantId, id, { status: 'delivered' });

    const order = (await getOrder(db as never, merchantId, id)) as {
      status: string;
      events: { type: string; payload: Record<string, unknown> }[];
    };
    expect(order.status).toBe('delivered');
    expect(order.events.map((e) => e.type)).toEqual([
      'status.confirmed',
      'status.packed',
      'status.shipped',
      'status.delivered',
    ]);
    // The tracking details are on the event, so the history answers "where was it sent".
    expect(order.events[2]!.payload).toMatchObject({ courier: 'Delhivery', awb: 'AWB123456' });
  });

  it('refuses an illegal transition and says what is possible instead', async () => {
    /**
     * Enforced here rather than trusted from the client: recording "shipped" on a cancelled
     * order would send a buyer a shipping notification for an order that was refunded.
     */
    const id = await makeOrder('cancelled');
    await expect(
      transitionOrder(deps(), merchantId, id, { status: 'shipped', courier: 'X', awb: 'Y' }),
    ).rejects.toThrow(/cannot become shipped.*final/is);
  });

  it('will not ship without a courier and a tracking number', async () => {
    // A buyer told "shipped" with no way to track it emails asking where it is.
    const id = await makeOrder('packed');
    await expect(
      transitionOrder(deps(), merchantId, id, { status: 'shipped' }),
    ).rejects.toThrow(/courier and a tracking number/i);
  });

  it('will not cancel without a reason the buyer can read', async () => {
    const id = await makeOrder('paid');
    await expect(
      transitionOrder(deps(), merchantId, id, { status: 'cancelled' }),
    ).rejects.toThrow(/reason/i);
  });

  it("refuses to touch another merchant's order", async () => {
    const id = await makeOrder('paid');
    await expect(
      transitionOrder(deps(), randomUUID(), id, { status: 'confirmed' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('surfaces how long a paid order has waited for acknowledgement', async () => {
    await makeOrder('paid');
    const { orders } = await listOrders(db as never, merchantId);
    const waiting = orders.find((o) => o.status === 'paid');
    // The number the dashboard sorts by — an unacknowledged order costs a review.
    expect(waiting?.awaitingAckHours).toBeGreaterThanOrEqual(0);
  });

  it('counts what needs the merchant now', async () => {
    const summary = await orderSummary(db as never, merchantId);
    expect(summary.needsAck).toBeGreaterThan(0);
    expect(summary.total).toBeGreaterThan(0);
  });
});
