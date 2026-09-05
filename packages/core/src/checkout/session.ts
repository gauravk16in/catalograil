import { z } from 'zod';

/**
 * T2.13 — the cart, and the conversation that produced it.
 *
 * `handoffContext` is the part that makes the split screen worth building. A buyer arriving
 * from Claude has already explained what they want, at length, and being asked again is the
 * moment the handoff stops feeling like one product. Carrying the summary, the original
 * query and the shortlist means the assistant on our page starts where the other one
 * stopped.
 */

export const cartItemSchema = z.object({
  productId: z.string().uuid(),
  variantId: z.string().uuid().optional(),
  quantity: z.number().int().min(1).max(20),
  merchantId: z.string().uuid(),
  /**
   * The price when it entered the cart, in paise as a string.
   *
   * Snapshotted so checkout can detect a change rather than silently charging a different
   * amount — a buyer quoted ₹1,999 and charged ₹2,199 has been defrauded, however innocent
   * the cause.
   */
  priceSnapshot: z.string(),
});

export const handoffContextSchema = z.object({
  conversationSummary: z.string().max(4000).optional(),
  originalQuery: z.string().max(500).optional(),
  shortlist: z.array(z.string().uuid()).max(20).optional(),
});

export const checkoutSessionSchema = z.object({
  sessionId: z.string(),
  buyerId: z.string().uuid().optional(),
  createdAt: z.string(),
  expiresAt: z.string(),
  handoffContext: handoffContextSchema.default({}),
  /** May span merchants; each is paid separately (T2.21). */
  cart: z.array(cartItemSchema),
  selectedAddressId: z.string().uuid().optional(),
  guestContact: z
    .object({ email: z.string().email().optional(), phone: z.string().optional() })
    .optional(),
});

export type CartItem = z.infer<typeof cartItemSchema>;
export type HandoffContext = z.infer<typeof handoffContextSchema>;
export type CheckoutSession = z.infer<typeof checkoutSessionSchema>;

/** 24 hours, matching the Sessions table TTL in §7. */
export const SESSION_TTL_SECONDS = 24 * 3600;

/**
 * T2.14 — the handoff token's lifetime.
 *
 * Fifteen minutes, because it travels in a URL: through a chat transcript, a browser
 * history, a referrer header, possibly a screenshot. It is a bearer credential in about the
 * most exposed place one can be, and the defences are that it stops working quickly and is
 * consumed on first use.
 */
export const HANDOFF_TOKEN_TTL_SECONDS = 15 * 60;

/** Groups a cart by merchant, because each merchant is paid on their own account (D4). */
export function groupByMerchant(cart: readonly CartItem[]): Map<string, CartItem[]> {
  const groups = new Map<string, CartItem[]>();
  for (const item of cart) {
    const existing = groups.get(item.merchantId);
    if (existing) existing.push(item);
    else groups.set(item.merchantId, [item]);
  }
  return groups;
}
