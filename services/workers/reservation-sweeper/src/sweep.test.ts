import { randomUUID } from 'node:crypto';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sweepReservations } from './sweep.js';

const DATABASE_URL = process.env.DATABASE_URL;
const NOW = new Date('2026-09-05T12:00:00Z');

describe.skipIf(!DATABASE_URL)('reservation sweeper', () => {
  let client: postgres.Sql;
  let db: PostgresJsDatabase;
  let merchantId: string;

  beforeAll(async () => {
    client = postgres(DATABASE_URL!, { max: 4, onnotice: () => {} });
    db = drizzle(client);
    merchantId = randomUUID();
    await client`
      INSERT INTO merchants (id, business_name, contact_email, status)
      VALUES (${merchantId}, 'Sweeper Test', ${`sw-${merchantId}@example.com`}, 'active')`;
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

  async function abandonedOrder(minutesAgo: number, status = 'awaiting_payment', stock = 0) {
    const [product] = await client<{ id: string }[]>`
      INSERT INTO products (merchant_id, archetype, name, status)
      VALUES (${merchantId}, 'SIMPLE', 'Swept Product', 'active') RETURNING id`;
    const [variant] = await client<{ id: string }[]>`
      INSERT INTO product_variants (product_id, sku, option_values, price_paise, stock, status)
      VALUES (${product!.id}, ${'SW-' + randomUUID().slice(0, 8)}, '{}', 100000, ${stock}, 'active')
      RETURNING id`;
    const createdAt = new Date(NOW.getTime() - minutesAgo * 60_000);
    const [order] = await client<{ id: string }[]>`
      INSERT INTO orders (order_number, buyer_email, merchant_id, status,
                          subtotal_paise, shipping_paise, tax_paise, total_paise, source, created_at)
      VALUES (${'ORD-' + randomUUID().slice(0, 6).toUpperCase()}, 'b@example.com', ${merchantId},
              ${status}, 100000, 0, 0, 100000, 'claude', ${createdAt.toISOString()})
      RETURNING id`;
    await client`
      INSERT INTO order_items (order_id, product_id, variant_id, name_snapshot, sku_snapshot,
                               unit_price_paise, quantity, line_total_paise)
      VALUES (${order!.id}, ${product!.id}, ${variant!.id}, 'Swept Product', 'SW', 100000, 2, 200000)`;
    return { orderId: order!.id, variantId: variant!.id };
  }

  it('returns stock from an abandoned checkout', async () => {
    // T2.17's acceptance: an abandoned checkout returns stock within 25 minutes.
    const { orderId, variantId } = await abandonedOrder(25);
    const result = await sweepReservations(db as never, NOW);

    expect(result.ordersExpired).toBeGreaterThanOrEqual(1);
    const [after] = await client`SELECT stock FROM product_variants WHERE id = ${variantId}`;
    expect(after!.stock).toBe(2);
    const [order] = await client`SELECT status FROM orders WHERE id = ${orderId}`;
    expect(order!.status).toBe('failed');
  });

  it('leaves a checkout that is still in progress alone', async () => {
    // Someone fetching their card should never be cut off mid-payment.
    const { orderId, variantId } = await abandonedOrder(5);
    await sweepReservations(db as never, NOW);

    const [after] = await client`SELECT stock FROM product_variants WHERE id = ${variantId}`;
    expect(after!.stock).toBe(0);
    const [order] = await client`SELECT status FROM orders WHERE id = ${orderId}`;
    expect(order!.status).toBe('awaiting_payment');
  });

  it('never touches an order that was already paid', async () => {
    /**
     * A paid order's reservation is a sale. Sweeping it would hand back stock the buyer has
     * paid for — inventory appearing from nowhere, which is far harder to notice than stock
     * going missing.
     */
    const { orderId, variantId } = await abandonedOrder(60, 'paid');
    await sweepReservations(db as never, NOW);

    const [after] = await client`SELECT stock FROM product_variants WHERE id = ${variantId}`;
    expect(after!.stock).toBe(0);
    const [order] = await client`SELECT status FROM orders WHERE id = ${orderId}`;
    expect(order!.status).toBe('paid');
  });

  it('does not release the same order twice', async () => {
    // Two sweeps overlapping, or a retry, must not double-credit the stock.
    const { variantId } = await abandonedOrder(30);
    await sweepReservations(db as never, NOW);
    await sweepReservations(db as never, NOW);

    const [after] = await client`SELECT stock FROM product_variants WHERE id = ${variantId}`;
    expect(after!.stock).toBe(2);
  });

  it('records why the order expired', async () => {
    // A buyer asking "what happened to my order" deserves an answer from the history.
    const { orderId } = await abandonedOrder(40);
    await sweepReservations(db as never, NOW);

    const events = await client`
      SELECT event_type, payload FROM order_events WHERE order_id = ${orderId}`;
    expect(events.map((e) => e.event_type)).toContain('order.expired');
  });
});
