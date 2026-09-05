import { randomUUID } from 'node:crypto';
import { fixedClock } from '@catalograil/core';
import { ReversibleTestCipher } from '@catalograil/razorpay';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrders, generateOrderNumber, type CheckoutDeps } from './checkout.js';

const DATABASE_URL = process.env.DATABASE_URL;
const NOW = new Date('2026-09-05T12:00:00Z');

describe.skipIf(!DATABASE_URL)('checkout', () => {
  let client: postgres.Sql;
  let db: PostgresJsDatabase;
  let merchantId: string;

  beforeAll(async () => {
    client = postgres(DATABASE_URL!, { max: 10, onnotice: () => {} });
    db = drizzle(client);
    merchantId = randomUUID();
    await client`
      INSERT INTO merchants (id, business_name, contact_email, status)
      VALUES (${merchantId}, 'Checkout Test', ${`co-${merchantId}@example.com`}, 'active')`;
    await client`
      INSERT INTO merchant_payment_config (merchant_id, method, key_id, key_secret_encrypted,
                                           key_secret_last4, status, mode)
      VALUES (${merchantId}, 'api_keys', 'rzp_test_ABCDEFGHIJKL',
              ${'test:' + Buffer.from('secret1234').toString('base64')}, '1234', 'verified', 'test')`;
  });

  afterAll(async () => {
    if (merchantId) {
      await client`DELETE FROM order_events WHERE order_id IN (
        SELECT id FROM orders WHERE merchant_id = ${merchantId})`;
      await client`DELETE FROM order_items WHERE order_id IN (
        SELECT id FROM orders WHERE merchant_id = ${merchantId})`;
      await client`DELETE FROM orders WHERE merchant_id = ${merchantId}`;
      await client`DELETE FROM merchants WHERE id = ${merchantId}`;
    }
    await client?.end();
  });

  /** Razorpay, stubbed. No test should create a real payment object. */
  function razorpayOk(): typeof fetch {
    return (async () =>
      new Response(
        JSON.stringify({ id: `order_${randomUUID().slice(0, 12)}`, amount: 1, currency: 'INR', status: 'created', receipt: 'r' }),
        { status: 200 },
      )) as never;
  }

  function deps(fetcher = razorpayOk()): CheckoutDeps {
    return {
      db: db as never,
      clock: fixedClock(NOW),
      cipherFor: () => new ReversibleTestCipher(),
      fetcher,
    };
  }

  async function makeVariant(stock: number, pricePaise = 199900n) {
    const [product] = await client<{ id: string }[]>`
      INSERT INTO products (merchant_id, archetype, name, status)
      VALUES (${merchantId}, 'SIMPLE', 'Checkout Product', 'active') RETURNING id`;
    const [variant] = await client<{ id: string }[]>`
      INSERT INTO product_variants (product_id, sku, option_values, price_paise, stock, status)
      VALUES (${product!.id}, ${'SKU-' + randomUUID().slice(0, 8)}, '{}', ${pricePaise}, ${stock}, 'active')
      RETURNING id`;
    return { productId: product!.id, variantId: variant!.id, pricePaise };
  }

  const buyer = {
    buyerEmail: 'buyer@example.com',
    shippingAddress: { line1: '12 MG Road', city: 'Bengaluru', pincode: '560001' },
    sessionId: 'sess-test',
    source: 'claude',
  };

  it('creates an order on the merchant’s account and snapshots their policies', async () => {
    const v = await makeVariant(5);
    const { results } = await createOrders(deps(), {
      ...buyer,
      cart: [
        { productId: v.productId, variantId: v.variantId, quantity: 1, merchantId, priceSnapshot: v.pricePaise.toString() },
      ],
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(true);
    expect(results[0]!.razorpayOrderId).toMatch(/^order_/);
    expect(results[0]!.orderNumber).toMatch(/^ORD-[2-9A-HJ-NP-Z]{6}$/);

    const [row] = await client`SELECT status, total_paise FROM orders WHERE id = ${results[0]!.orderId!}`;
    expect(row!.status).toBe('awaiting_payment');
  });

  it('resolves a concurrent race for one unit to exactly one winner', async () => {
    /**
     * T2.15's acceptance, and the reason reservation is a conditional UPDATE rather than a
     * read-then-write. Three buyers all read `stock = 1`; exactly one update can match
     * `WHERE stock >= 1`. Without this all three succeed and two find out after paying.
     */
    const v = await makeVariant(1);
    const attempt = () =>
      createOrders(deps(), {
        ...buyer,
        cart: [
          { productId: v.productId, variantId: v.variantId, quantity: 1, merchantId, priceSnapshot: v.pricePaise.toString() },
        ],
      });

    const outcomes = await Promise.all([attempt(), attempt(), attempt()]);
    const succeeded = outcomes.filter((o) => o.results[0]!.ok);
    const failed = outcomes.filter((o) => !o.results[0]!.ok);

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(2);
    for (const f of failed) expect(f.results[0]!.errorCode).toBe('INSUFFICIENT_STOCK');

    const [after] = await client`SELECT stock FROM product_variants WHERE id = ${v.variantId}`;
    // Never negative, which is what a read-then-write would have produced.
    expect(after!.stock).toBe(0);
  });

  it('refuses when the price moved since the cart was filled', async () => {
    // A buyer quoted ₹1,999 and charged ₹2,199 has been defrauded however innocent the cause.
    const v = await makeVariant(5);
    const { results } = await createOrders(deps(), {
      ...buyer,
      cart: [
        { productId: v.productId, variantId: v.variantId, quantity: 1, merchantId, priceSnapshot: '100000' },
      ],
    });
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.errorCode).toBe('PRICE_MOVED');
  });

  it('releases the reservation when Razorpay refuses', async () => {
    /**
     * Twenty minutes of phantom scarcity for an error we already know about would make a
     * merchant's last unit unbuyable because someone's card form timed out.
     */
    const v = await makeVariant(3);
    const refusing = (async () => new Response('{"error":"nope"}', { status: 400 })) as never;

    const { results } = await createOrders(deps(refusing), {
      ...buyer,
      cart: [
        { productId: v.productId, variantId: v.variantId, quantity: 2, merchantId, priceSnapshot: v.pricePaise.toString() },
      ],
    });

    expect(results[0]!.ok).toBe(false);
    const [after] = await client`SELECT stock FROM product_variants WHERE id = ${v.variantId}`;
    expect(after!.stock).toBe(3);
  });

  it('keeps one merchant’s order when another fails', async () => {
    /**
     * T2.21: never roll back a successful payment. A function that threw on the first
     * failure would force the caller to undo one that already worked.
     */
    const good = await makeVariant(5);
    const soldOut = await makeVariant(0);

    const { results } = await createOrders(deps(), {
      ...buyer,
      cart: [
        { productId: good.productId, variantId: good.variantId, quantity: 1, merchantId, priceSnapshot: good.pricePaise.toString() },
        { productId: soldOut.productId, variantId: soldOut.variantId, quantity: 1, merchantId, priceSnapshot: soldOut.pricePaise.toString() },
      ],
    });

    // Same merchant here, so one group: the group fails as a unit and releases what it took.
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(false);
    const [after] = await client`SELECT stock FROM product_variants WHERE id = ${good.variantId}`;
    expect(after!.stock).toBe(5);
  });

  it('refuses a merchant who is not active', async () => {
    const other = randomUUID();
    await client`
      INSERT INTO merchants (id, business_name, contact_email, status)
      VALUES (${other}, 'Suspended', ${`s-${other}@example.com`}, 'suspended')`;
    try {
      const { results } = await createOrders(deps(), {
        ...buyer,
        cart: [{ productId: randomUUID(), quantity: 1, merchantId: other, priceSnapshot: '1' }],
      });
      expect(results[0]!.ok).toBe(false);
      expect(results[0]!.errorCode).toBe('MERCHANT_SUSPENDED');
    } finally {
      await client`DELETE FROM merchants WHERE id = ${other}`;
    }
  });
});

describe('generateOrderNumber', () => {
  it('avoids characters that are ambiguous read aloud', () => {
    /**
     * The random suffix only. The `ORD-` prefix is constant and contains an O, which is
     * fine precisely because it never varies — nobody has to transcribe it.
     */
    for (let i = 0; i < 200; i++) {
      const suffix = generateOrderNumber().slice(4);
      expect(suffix, generateOrderNumber()).not.toMatch(/[IO01]/);
      expect(suffix).toHaveLength(6);
    }
  });
});
