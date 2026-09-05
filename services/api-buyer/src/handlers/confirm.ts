import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError, type Clock } from '@catalograil/core';
import { orderEvents, orders, type Database } from '@catalograil/db';
import { getRazorpayClient, type RazorpayClientDeps } from '@catalograil/razorpay';
import { eq } from 'drizzle-orm';

/**
 * Confirming a payment from the browser, after Razorpay Checkout succeeds.
 *
 * The webhook (T2.16) remains the source of truth — it is the only path that works when the
 * buyer closes the tab the instant they pay, and the only one Razorpay guarantees. But it
 * cannot be the *only* path:
 *
 *   - A merchant testing with test-mode keys has usually not registered a webhook yet, so
 *     their first order would sit at `awaiting_payment` forever while the payment plainly
 *     succeeded. That is indistinguishable from the product being broken.
 *   - Even configured, a webhook lands seconds later. A buyer staring at a spinner in the
 *     meantime has no way to tell "confirming" from "failed".
 *
 * So both paths write the same transition, both are idempotent, and whichever arrives first
 * wins. That is the whole design: this is a fast path, not a second source of truth.
 */

export interface ConfirmDeps extends RazorpayClientDeps {
  readonly db: Database;
  readonly clock: Clock;
}

export interface ConfirmInput {
  readonly orderId: string;
  readonly razorpayPaymentId: string;
  readonly razorpayOrderId: string;
  readonly razorpaySignature: string;
}

export async function confirmPayment(
  deps: ConfirmDeps,
  input: ConfirmInput,
): Promise<{ status: string; orderNumber: string | null; alreadyConfirmed: boolean }> {
  const [order] = await deps.db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      merchantId: orders.merchantId,
      razorpayOrderId: orders.razorpayOrderId,
    })
    .from(orders)
    .where(eq(orders.id, input.orderId))
    .limit(1);

  if (!order) throw new AppError('NOT_FOUND', 'No such order.');

  /**
   * The order id in the callback must match the one we created.
   *
   * Razorpay signs `order_id|payment_id`, so a caller who swapped in a different order id
   * would fail the signature check anyway — but checking here means the error names the
   * actual problem instead of "signature mismatch", which sends someone hunting for a key
   * rotation that never happened.
   */
  if (order.razorpayOrderId !== input.razorpayOrderId) {
    throw new AppError('VALIDATION_FAILED', 'That payment belongs to a different order.');
  }

  const client = await getRazorpayClient(deps, order.merchantId);
  if (client.connection.method !== 'api_keys') {
    throw new AppError('PAYMENT_CONFIG_INVALID', 'This merchant is not on API-key payments.');
  }

  /**
   * Razorpay's checkout signature: HMAC-SHA256 of `order_id|payment_id` under the key secret.
   *
   * This is the entire security of the browser path. Without it, anyone who knows an order id
   * could mark it paid by calling this endpoint — the callback arrives from the buyer's own
   * browser and is trivially forgeable otherwise.
   */
  const expected = createHmac('sha256', client.connection.keySecret)
    .update(`${input.razorpayOrderId}|${input.razorpayPaymentId}`)
    .digest('hex');

  const given = Buffer.from(input.razorpaySignature, 'utf8');
  const want = Buffer.from(expected, 'utf8');
  // Constant-time: this is a signature check on an attacker-suppliable value that can be
  // retried, and an early-returning comparison leaks how much of a forgery was correct.
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    throw new AppError('VALIDATION_FAILED', 'That payment signature did not verify.');
  }

  // The webhook may have arrived first. Both write the same transition, so the second is a
  // no-op rather than a conflict.
  if (['paid', 'confirmed', 'packed', 'shipped', 'delivered'].includes(order.status)) {
    return { status: order.status, orderNumber: order.orderNumber, alreadyConfirmed: true };
  }

  const now = deps.clock.now();
  await deps.db.transaction(async (tx) => {
    await tx
      .update(orders)
      .set({ status: 'paid', razorpayPaymentId: input.razorpayPaymentId, updatedAt: now })
      .where(eq(orders.id, input.orderId));

    await tx.insert(orderEvents).values({
      orderId: input.orderId,
      eventType: 'payment.paid',
      // Named so a merchant reading the history can tell a browser confirmation from a
      // webhook — useful when a payment is disputed and the timing matters.
      actor: 'checkout',
      payload: { razorpayPaymentId: input.razorpayPaymentId } as never,
    });
  });

  return { status: 'paid', orderNumber: order.orderNumber, alreadyConfirmed: false };
}
