import { orderEvents, orderItems, orders, productVariants, type Database } from '@catalograil/db';
import { and, eq, lt, sql } from 'drizzle-orm';

/**
 * T2.17 — returns stock that a checkout reserved and never paid for.
 *
 * Reservation happens before payment (T2.15), which is correct — a buyer must not be able to
 * pay for something that has already sold out. The cost is that an abandoned checkout holds
 * stock, and without this a merchant's last unit becomes unbuyable because someone opened a
 * payment page and closed the tab.
 *
 * Twenty minutes, per T2.17. Long enough that a buyer fetching their card is never cut off
 * mid-payment; short enough that abandoned carts do not accumulate through a working day.
 */
export const RESERVATION_TIMEOUT_MINUTES = 20;

export interface SweepResult {
  readonly ordersExpired: number;
  readonly unitsReleased: number;
}

export async function sweepReservations(
  db: Database,
  now: Date,
  timeoutMinutes = RESERVATION_TIMEOUT_MINUTES,
): Promise<SweepResult> {
  const cutoff = new Date(now.getTime() - timeoutMinutes * 60_000);

  /**
   * Only `awaiting_payment`, and only older than the cutoff.
   *
   * An order that reached `paid` has had its reservation converted into a sale, and one that
   * already `failed` had its stock released by the webhook. Sweeping either would hand back
   * stock twice — which reads as free inventory appearing from nowhere and is far harder to
   * notice than stock going missing.
   */
  const stale = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.status, 'awaiting_payment'), lt(orders.createdAt, cutoff)))
    .limit(500);

  let unitsReleased = 0;

  for (const order of stale) {
    const items = await db
      .select({ variantId: orderItems.variantId, quantity: orderItems.quantity })
      .from(orderItems)
      .where(eq(orderItems.orderId, order.id));

    await db.transaction(async (tx) => {
      /**
       * The status change is conditional on the order still being `awaiting_payment`.
       *
       * A capture webhook can land while this sweep is running. Without the predicate the
       * sweeper would mark a just-paid order expired and return stock the buyer has paid
       * for — so the update returns zero rows in that race and the stock stays taken.
       */
      const claimed = await tx
        .update(orders)
        .set({ status: 'failed', updatedAt: now })
        .where(and(eq(orders.id, order.id), eq(orders.status, 'awaiting_payment')))
        .returning({ id: orders.id });

      if (claimed.length === 0) return;

      for (const item of items) {
        if (!item.variantId) continue;
        await tx
          .update(productVariants)
          .set({ stock: sql`${productVariants.stock} + ${item.quantity}` })
          .where(eq(productVariants.id, item.variantId));
        unitsReleased += item.quantity;
      }

      await tx.insert(orderEvents).values({
        orderId: order.id,
        eventType: 'order.expired',
        actor: 'system',
        payload: { reason: `No payment within ${timeoutMinutes} minutes.` } as never,
      });
    });
  }

  return { ordersExpired: stale.length, unitsReleased };
}
