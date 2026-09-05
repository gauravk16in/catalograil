import { randomUUID } from 'node:crypto';
import { fixedClock } from '@catalograil/core';
import { InMemorySessionStore } from '@catalograil/aws';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCheckoutSession, redeemHandoffToken, updateSession, type SessionDeps } from './session.js';

const DATABASE_URL = process.env.DATABASE_URL;
const NOW = new Date('2026-09-05T12:00:00Z');
const SECRET = 'handoff-signing-secret-for-tests';

describe.skipIf(!DATABASE_URL)('checkout sessions', () => {
  let client: postgres.Sql;
  let db: PostgresJsDatabase;
  let merchantId: string;
  let productId: string;
  let variantId: string;

  beforeAll(async () => {
    client = postgres(DATABASE_URL!, { max: 4, onnotice: () => {} });
    db = drizzle(client);
    merchantId = randomUUID();
    await client`
      INSERT INTO merchants (id, business_name, contact_email, status)
      VALUES (${merchantId}, 'Session Test', ${`se-${merchantId}@example.com`}, 'active')`;
    const [product] = await client<{ id: string }[]>`
      INSERT INTO products (merchant_id, archetype, name, status)
      VALUES (${merchantId}, 'SIMPLE', 'Session Product', 'active') RETURNING id`;
    productId = product!.id;
    const [variant] = await client<{ id: string }[]>`
      INSERT INTO product_variants (product_id, sku, option_values, price_paise, stock, status)
      VALUES (${productId}, ${'SE-' + randomUUID().slice(0, 8)}, '{"size":"42"}', 199900, 5, 'active')
      RETURNING id`;
    variantId = variant!.id;
  });

  afterAll(async () => {
    if (merchantId) await client`DELETE FROM merchants WHERE id = ${merchantId}`;
    await client?.end();
  });

  function deps(store = new InMemorySessionStore()): SessionDeps {
    return {
      db: db as never,
      sessions: store as never,
      clock: fixedClock(NOW),
      handoffSecret: SECRET,
      buyerAppUrl: 'https://buy.test',
    };
  }

  it('creates a session and a URL carrying the handoff context', async () => {
    const store = new InMemorySessionStore();
    const created = await createCheckoutSession(deps(store), {
      productId,
      variantId,
      quantity: 2,
      handoffContext: {
        originalQuery: 'a formal shirt for the office',
        conversationSummary: 'Buyer wants cotton, size 42, under ₹2500.',
        shortlist: [productId],
      },
    });

    // A query parameter, not a path segment: the buyer app is a static export and a dynamic
    // segment would need every token enumerated at build time.
    expect(created.checkoutUrl).toBe(`https://buy.test/s?t=${encodeURIComponent(created.token)}`);

    const session = await redeemHandoffToken(deps(store), created.token);
    // The whole reason the split screen is worth building: the buyer never re-explains.
    expect(session.handoffContext.originalQuery).toBe('a formal shirt for the office');
    expect(session.cart[0]).toMatchObject({ variantId, quantity: 2, merchantId });
  });

  it('reserves no stock, because a link is not a purchase', async () => {
    /**
     * Reserving here would let anyone empty a merchant's inventory by asking an assistant
     * for checkout links. The reservation happens when a buyer actually pays (T2.15).
     */
    await createCheckoutSession(deps(), { productId, variantId, quantity: 3 });
    const [row] = await client`SELECT stock FROM product_variants WHERE id = ${variantId}`;
    expect(row!.stock).toBe(5);
  });

  it('refuses when there is not enough stock to begin with', async () => {
    await expect(
      createCheckoutSession(deps(), { productId, variantId, quantity: 99 }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
  });

  it('refuses a token that has already been opened', async () => {
    /**
     * T2.14's acceptance. The URL survives in a browser history and a chat transcript, so a
     * token that stayed valid would let anyone with the scrollback resume a cart carrying
     * someone's address and contact details.
     */
    const store = new InMemorySessionStore();
    const created = await createCheckoutSession(deps(store), { productId, variantId });

    await redeemHandoffToken(deps(store), created.token);
    await expect(redeemHandoffToken(deps(store), created.token)).rejects.toMatchObject({
      code: 'INVALID_HANDOFF_TOKEN',
    });
  });

  it('tells an expired link apart from an invalid one', async () => {
    // The page shows "start again" rather than a failure, which it can only do because the
    // code says which it was.
    const store = new InMemorySessionStore();
    const created = await createCheckoutSession(deps(store), { productId, variantId });

    const later: SessionDeps = { ...deps(store), clock: fixedClock(new Date(NOW.getTime() + 20 * 60_000)) };
    await expect(redeemHandoffToken(later, created.token)).rejects.toMatchObject({
      code: 'HANDOFF_TOKEN_EXPIRED',
    });
  });

  it('keeps the address chosen on the page', async () => {
    const store = new InMemorySessionStore();
    const created = await createCheckoutSession(deps(store), { productId, variantId });
    const addressId = randomUUID();

    const updated = await updateSession(deps(store), created.sessionId, {
      selectedAddressId: addressId,
    });
    expect(updated.selectedAddressId).toBe(addressId);
    expect((await store.get(created.sessionId))!.selectedAddressId).toBe(addressId);
  });
});
