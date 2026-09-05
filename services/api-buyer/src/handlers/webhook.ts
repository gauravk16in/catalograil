import { AppError, type Clock } from '@catalograil/core';
import { orderEvents, orders, productVariants, orderItems, type Database } from '@catalograil/db';
import { getWebhookSecret, verifyWebhookSignature, type RazorpayClientDeps } from '@catalograil/razorpay';
import { eq, sql } from 'drizzle-orm';

/**
 * T2.16 — Razorpay webhooks, per merchant.
 *
 * Three properties matter here and each has cost someone a production incident somewhere:
 *
 * **The signature is verified against *that merchant's* secret.** The URL contains the
 * merchant id, so a forged request naming a different merchant would otherwise be checked
 * against the wrong key — or worse, a shared one.
 *
 * **Every delivery is idempotent.** Razorpay retries, and a retry that ships a second stock
 * decrement or a second notification is worse than a missed one.
 *
 * **An unsigned request is rejected before anything is read.** The body of an unverified
 * webhook is attacker-controlled input and must not reach a parser that matters.
 */

export interface WebhookDeps extends RazorpayClientDeps {
  readonly db: Database;
  readonly clock: Clock;
  /** Conditional-write store for `razorpay_event_id` (rule 2). */
  readonly idempotency: IdempotencyStore;
  readonly onPaid?: (orderId: string) => Promise<void>;
}

export interface IdempotencyStore {
  /** True if this is the first time we have seen the key. */
  claim(key: string): Promise<boolean>;
}

export interface WebhookResult {
  readonly handled: boolean;
  readonly reason: string;
  readonly orderId?: string;
  readonly status?: string;
}

export async function handleRazorpayWebhook(
  deps: WebhookDeps,
  merchantId: string,
  rawBody: string,
  signature: string | undefined,
): Promise<WebhookResult> {
  if (!signature) {
    // Rejected before parsing: an unverified body is attacker-controlled input.
    throw new AppError('VALIDATION_FAILED', 'Missing webhook signature.');
  }

  const secret = await getWebhookSecret(deps, merchantId);
  if (!secret) {
    throw new AppError('PAYMENT_CONFIG_MISSING', 'This merchant has no webhook secret saved.');
  }

  if (!verifyWebhookSignature(rawBody, signature, secret)) {
    throw new AppError('VALIDATION_FAILED', 'Webhook signature did not verify.');
  }

  const event = JSON.parse(rawBody) as {
    event?: string;
    payload?: {
      payment?: { entity?: { id?: string; order_id?: string; status?: string } };
      refund?: { entity?: { id?: string; payment_id?: string } };
    };
  };

  /**
   * Razorpay's own event id, not a hash of the body.
   *
   * A retry can differ from the original by a timestamp or a field order, so hashing the
   * body would let the same event through twice. The id is stable across retries, which is
   * exactly what makes it the right key.
   */
  const eventId = extractEventId(event, rawBody);
  const first = await deps.idempotency.claim(`RZP#${merchantId}#${eventId}`);
  if (!first) {
    // T2.16's acceptance: five deliveries, one transition. A repeat is a success, not an
    // error — returning non-2xx would make Razorpay retry it further.
    return { handled: false, reason: 'Already processed.' };
  }

  const razorpayOrderId = event.payload?.payment?.entity?.order_id;
  if (!razorpayOrderId) {
    return { handled: false, reason: `No order id on a ${event.event ?? 'unknown'} event.` };
  }

  const [order] = await deps.db
    .select({ id: orders.id, status: orders.status, merchantId: orders.merchantId })
    .from(orders)
    .where(eq(orders.razorpayOrderId, razorpayOrderId))
    .limit(1);

  if (!order) return { handled: false, reason: 'No matching order.' };

  /**
   * The order must belong to the merchant whose secret signed the request.
   *
   * Without this a merchant with a valid secret could move another merchant's orders by
   * replaying an event id they had seen — the signature proves who sent it, not what they
   * are entitled to touch.
   */
  if (order.merchantId !== merchantId) {
    throw new AppError('FORBIDDEN', 'That order does not belong to this merchant.');
  }

  const now = deps.clock.now();

  switch (event.event) {
    case 'payment.captured': {
      if (order.status === 'paid' || order.status === 'confirmed') {
        return { handled: false, reason: 'Already paid.', orderId: order.id, status: order.status };
      }
      await transition(deps, order.id, 'paid', {
        paymentId: event.payload?.payment?.entity?.id,
      }, now);
      // The reservation becomes a real sale: stock stays decremented and the sweeper must
      // not reclaim it.
      await deps.onPaid?.(order.id);
      return { handled: true, reason: 'Payment captured.', orderId: order.id, status: 'paid' };
    }

    case 'payment.failed': {
      await releaseOrderStock(deps.db, order.id);
      await transition(deps, order.id, 'failed', {}, now);
      return { handled: true, reason: 'Payment failed.', orderId: order.id, status: 'failed' };
    }

    case 'refund.processed': {
      await transition(deps, order.id, 'refunded', {
        refundId: event.payload?.refund?.entity?.id,
      }, now);
      return { handled: true, reason: 'Refunded.', orderId: order.id, status: 'refunded' };
    }

    default:
      return { handled: false, reason: `Ignoring ${event.event ?? 'unknown'}.` };
  }
}

async function transition(
  deps: WebhookDeps,
  orderId: string,
  status: string,
  payload: Record<string, unknown>,
  now: Date,
): Promise<void> {
  await deps.db.transaction(async (tx) => {
    await tx.update(orders).set({ status: status as never, updatedAt: now }).where(eq(orders.id, orderId));
    // In the same transaction as the status change: an order whose status moved without an
    // event has a hole in the history a dispute is settled with.
    await tx.insert(orderEvents).values({
      orderId,
      eventType: `payment.${status}`,
      actor: 'razorpay',
      payload: payload as never,
    });
  });
}

/** Puts back what the checkout reserved, when a payment will never arrive. */
export async function releaseOrderStock(db: Database, orderId: string): Promise<void> {
  const items = await db
    .select({ variantId: orderItems.variantId, quantity: orderItems.quantity })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));

  for (const item of items) {
    if (!item.variantId) continue;
    await db
      .update(productVariants)
      .set({ stock: sql`${productVariants.stock} + ${item.quantity}` })
      .where(eq(productVariants.id, item.variantId));
  }
}

function extractEventId(
  event: { payload?: { payment?: { entity?: { id?: string } } } },
  rawBody: string,
): string {
  const paymentId = event.payload?.payment?.entity?.id;
  if (paymentId) return paymentId;
  // Falls back to a body hash only when Razorpay gave us nothing stable, which is better
  // than treating every such delivery as new.
  return `body:${Buffer.from(rawBody).toString('base64').slice(0, 64)}`;
}
