import { randomUUID } from 'node:crypto';
import {
  AppError,
  SESSION_TTL_SECONDS,
  issueHandoffToken,
  verifyHandoffToken,
  type CartItem,
  type CheckoutSession,
  type Clock,
  type HandoffContext,
} from '@catalograil/core';
import { productVariants, products, type Database } from '@catalograil/db';
import { eq } from 'drizzle-orm';

/**
 * T2.13 — checkout sessions, and the token that carries one into the browser.
 *
 * The session is the memory of a conversation that happened somewhere else. Its most
 * valuable field is `handoffContext`: a buyer who arrives from Claude has already explained
 * what they want at length, and being asked again is the moment the handoff stops feeling
 * like one product.
 */

export interface SessionStore {
  put(session: CheckoutSession): Promise<void>;
  get(sessionId: string): Promise<CheckoutSession | null>;
  /** True if this token had not been used before. */
  consumeToken(token: string): Promise<boolean>;
}

export interface SessionDeps {
  readonly db: Database;
  readonly sessions: SessionStore;
  readonly clock: Clock;
  readonly handoffSecret: string;
  readonly buyerAppUrl: string;
}

export async function createCheckoutSession(
  deps: SessionDeps,
  input: {
    productId: string;
    variantId?: string;
    quantity?: number;
    buyerEmail?: string;
    handoffContext?: HandoffContext;
  },
): Promise<{ sessionId: string; token: string; checkoutUrl: string; expiresAt: string; summary: unknown }> {
  const quantity = input.quantity ?? 1;

  const [row] = await deps.db
    .select({
      variantId: productVariants.id,
      sku: productVariants.sku,
      optionValues: productVariants.optionValues,
      pricePaise: productVariants.pricePaise,
      stock: productVariants.stock,
      status: productVariants.status,
      productId: products.id,
      productName: products.name,
      merchantId: products.merchantId,
      productStatus: products.status,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(
      input.variantId
        ? eq(productVariants.id, input.variantId)
        : eq(productVariants.productId, input.productId),
    )
    .limit(1);

  if (!row || row.status !== 'active' || row.productStatus === 'archived') {
    throw new AppError('NOT_FOUND', 'That product is no longer available.');
  }

  /**
   * Stock is checked but **not reserved** here.
   *
   * A session is a link someone may or may not open — reserving against it would let anyone
   * empty a merchant's inventory by asking an assistant for checkout links. The reservation
   * happens at T2.15, when a buyer actually pays.
   */
  if ((row.stock ?? 0) < quantity) {
    throw new AppError('INSUFFICIENT_STOCK', `${row.productName} does not have that many left.`);
  }

  const now = deps.clock.now();
  const sessionId = randomUUID();
  const cart: CartItem[] = [
    {
      productId: row.productId,
      variantId: row.variantId,
      quantity,
      merchantId: row.merchantId,
      priceSnapshot: (row.pricePaise ?? 0n).toString(),
    },
  ];

  const session: CheckoutSession = {
    sessionId,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString(),
    handoffContext: input.handoffContext ?? {},
    cart,
    ...(input.buyerEmail ? { guestContact: { email: input.buyerEmail } } : {}),
  };

  await deps.sessions.put(session);
  const handoff = issueHandoffToken(sessionId, deps.handoffSecret, now);

  return {
    sessionId,
    token: handoff.token,
    // A query parameter, not a path segment: the buyer app is a static export and a dynamic
    // segment would need every token enumerated at build time.
    checkoutUrl: `${deps.buyerAppUrl.replace(/\/$/, '')}/s?t=${encodeURIComponent(handoff.token)}`,
    expiresAt: handoff.expiresAt,
    summary: {
      product: row.productName,
      sku: row.sku,
      options: row.optionValues ?? {},
      quantity,
      unit_price_paise: (row.pricePaise ?? 0n).toString(),
      total_paise: ((row.pricePaise ?? 0n) * BigInt(quantity)).toString(),
    },
  };
}

/**
 * T2.14 — exchanges the URL token for the session, once.
 *
 * Consumption is the point: the token remains in the browser history and the chat
 * transcript after this, so it must stop being a credential the moment it has been used.
 * The page holds the session id afterwards, in its own storage, not in the URL.
 */
export async function redeemHandoffToken(
  deps: SessionDeps,
  token: string,
): Promise<CheckoutSession> {
  const verified = verifyHandoffToken(token, deps.handoffSecret, deps.clock.now());

  const fresh = await deps.sessions.consumeToken(verified.token);
  if (!fresh) {
    /**
     * A replayed token is refused even though the session is still fine.
     *
     * The alternative — letting it through because nothing has obviously gone wrong — means
     * anyone with the scrollback can resume a cart carrying someone's address and contact
     * details.
     */
    throw new AppError('INVALID_HANDOFF_TOKEN', 'This link has already been opened.');
  }

  const session = await deps.sessions.get(verified.sessionId);
  if (!session) {
    throw new AppError('HANDOFF_TOKEN_EXPIRED', 'This checkout has expired. Start again from the chat.');
  }
  return session;
}

/** Updates a session in place — a variant change, an address choice, a cart edit. */
export async function updateSession(
  deps: SessionDeps,
  sessionId: string,
  patch: Partial<Pick<CheckoutSession, 'cart' | 'selectedAddressId' | 'guestContact' | 'buyerId'>>,
): Promise<CheckoutSession> {
  const existing = await deps.sessions.get(sessionId);
  if (!existing) throw new AppError('NOT_FOUND', 'No such checkout session.');

  const updated: CheckoutSession = { ...existing, ...patch };
  await deps.sessions.put(updated);
  return updated;
}
