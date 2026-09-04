import { AppError, ORDER_STATUSES, type Clock, type OrderStatus } from '@catalograil/core';
import { orderEvents, orderItems, orders, type Database } from '@catalograil/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

/**
 * S6.3 — order management.
 *
 * The orders table has existed since Phase 1 with nothing to write to it. Building the
 * screens now means Phase 2's payments land somewhere that already works, rather than
 * arriving alongside a UI written in a hurry to receive them.
 *
 * The lifecycle is enforced here rather than trusted from the client. A merchant marking a
 * cancelled order as shipped is a mistake, and the useful response is to say so — not to
 * record it and let the buyer receive a shipping notification for a refunded order.
 */

/**
 * Which transitions are legal, keyed by current status.
 *
 * `delivered`, `refunded` and `cancelled` are terminal: there is no merchant action that
 * moves an order out of them, and anything that looks like one is really a new order or a
 * support conversation.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<string, readonly OrderStatus[]>> = {
  awaiting_payment: ['cancelled', 'failed'],
  paid: ['confirmed', 'cancelled', 'refunded'],
  confirmed: ['packed', 'cancelled', 'refunded'],
  packed: ['shipped', 'cancelled', 'refunded'],
  shipped: ['delivered', 'refunded'],
  delivered: [],
  cancelled: [],
  refunded: [],
  failed: ['cancelled'],
};

export interface OrderRow {
  readonly id: string;
  readonly orderNumber: string;
  readonly buyerEmail: string;
  readonly status: string;
  readonly totalPaise: string;
  readonly itemCount: number;
  readonly source: string | null;
  readonly createdAt: string;
  /** Hours since it was paid and still unacknowledged; null once confirmed. */
  readonly awaitingAckHours: number | null;
}

export async function listOrders(
  db: Database,
  merchantId: string,
  options: { status?: string; limit?: number } = {},
): Promise<{ orders: OrderRow[]; total: number }> {
  const limit = Math.min(options.limit ?? 50, 200);
  const conditions = [eq(orders.merchantId, merchantId)];
  // Narrowed against the constant rather than cast: a filter value from a query string is
  // client input, and an unknown one should return nothing rather than error at the driver.
  if (options.status && (ORDER_STATUSES as readonly string[]).includes(options.status)) {
    conditions.push(eq(orders.status, options.status as OrderStatus));
  }

  const rows = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      buyerEmail: orders.buyerEmail,
      status: orders.status,
      totalPaise: orders.totalPaise,
      source: orders.source,
      createdAt: orders.createdAt,
      itemCount: sql<number>`(
        SELECT COUNT(*)::int FROM ${orderItems} oi WHERE oi.order_id = ${orders.id}
      )`,
    })
    .from(orders)
    .where(and(...conditions))
    .orderBy(desc(orders.createdAt))
    .limit(limit);

  const now = Date.now();
  return {
    orders: rows.map((row) => ({
      id: row.id,
      orderNumber: row.orderNumber ?? row.id.slice(0, 8),
      buyerEmail: row.buyerEmail,
      status: row.status,
      totalPaise: row.totalPaise?.toString() ?? '0',
      itemCount: row.itemCount,
      source: row.source,
      createdAt: row.createdAt.toISOString(),
      // The number the dashboard sorts by: an order paid three days ago and never
      // acknowledged is the one costing the merchant a review.
      awaitingAckHours:
        row.status === 'paid'
          ? Math.floor((now - row.createdAt.getTime()) / 3_600_000)
          : null,
    })),
    total: rows.length,
  };
}

export async function getOrder(
  db: Database,
  merchantId: string,
  orderId: string,
): Promise<Record<string, unknown>> {
  const [order] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.merchantId, merchantId)))
    .limit(1);

  if (!order) throw new AppError('NOT_FOUND', 'No such order.');

  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  const events = await db
    .select()
    .from(orderEvents)
    .where(eq(orderEvents.orderId, orderId))
    .orderBy(orderEvents.createdAt);

  return {
    ...order,
    subtotalPaise: order.subtotalPaise?.toString() ?? null,
    shippingPaise: order.shippingPaise?.toString() ?? null,
    taxPaise: order.taxPaise?.toString() ?? null,
    totalPaise: order.totalPaise?.toString() ?? null,
    items: items.map((item) => ({
      ...item,
      unitPricePaise: item.unitPricePaise?.toString() ?? null,
      lineTotalPaise: item.lineTotalPaise?.toString() ?? null,
    })),
    events: events.map((e) => ({
      type: e.eventType,
      actor: e.actor,
      payload: e.payload,
      at: e.createdAt.toISOString(),
    })),
  };
}

const transitionSchema = z.object({
  status: z.string().trim().min(1),
  /** Shipped only. Both required together — a tracking number with no courier is unusable. */
  awb: z.string().trim().max(120).optional(),
  courier: z.string().trim().max(120).optional(),
  /** Cancellation only. The buyer sees this, so it is required rather than optional. */
  reason: z.string().trim().max(500).optional(),
});

export interface OrderDeps {
  readonly db: Database;
  readonly clock: Clock;
}

export async function transitionOrder(
  deps: OrderDeps,
  merchantId: string,
  orderId: string,
  body: unknown,
): Promise<{ orderId: string; status: string }> {
  const parsed = transitionSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 'A target status is required.', {
      details: { issues: parsed.error.issues },
    });
  }
  const { status, awb, courier, reason } = parsed.data;

  const [order] = await deps.db
    .select({ id: orders.id, status: orders.status })
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.merchantId, merchantId)))
    .limit(1);

  if (!order) throw new AppError('NOT_FOUND', 'No such order.');

  const allowed = ALLOWED_TRANSITIONS[order.status] ?? [];
  if (!allowed.includes(status as OrderStatus)) {
    throw new AppError(
      'CONFLICT',
      `An order that is ${order.status} cannot become ${status}.` +
        (allowed.length > 0 ? ` It can become: ${allowed.join(', ')}.` : ' That status is final.'),
    );
  }

  if (status === 'shipped' && (!awb || !courier)) {
    // A buyer told "shipped" with no way to track it will email asking where it is.
    throw new AppError('VALIDATION_FAILED', 'Shipping needs both a courier and a tracking number.');
  }
  if (status === 'cancelled' && !reason) {
    throw new AppError('VALIDATION_FAILED', 'A cancellation needs a reason the buyer can read.');
  }

  const now = deps.clock.now();

  await deps.db.transaction(async (tx) => {
    await tx
      .update(orders)
      .set({ status: status as OrderStatus, updatedAt: now })
      .where(eq(orders.id, orderId));

    /**
     * The event is written in the same transaction as the status change.
     *
     * An order whose status moved without a corresponding event has a hole in its history,
     * and the history is what a dispute is settled with.
     */
    await tx.insert(orderEvents).values({
      orderId,
      eventType: `status.${status}`,
      actor: 'merchant',
      payload: {
        from: order.status,
        to: status,
        ...(awb ? { awb } : {}),
        ...(courier ? { courier } : {}),
        ...(reason ? { reason } : {}),
      },
    });
  });

  return { orderId, status };
}

/** The dashboard's "needs you" number (S6.4). */
export async function orderSummary(
  db: Database,
  merchantId: string,
): Promise<{ needsAck: number; inFlight: number; total: number }> {
  const rows = await db
    .select({ status: orders.status, count: sql<number>`COUNT(*)::int` })
    .from(orders)
    .where(eq(orders.merchantId, merchantId))
    .groupBy(orders.status);

  const by = new Map(rows.map((r) => [r.status, r.count]));
  return {
    needsAck: by.get('paid') ?? 0,
    inFlight: (by.get('confirmed') ?? 0) + (by.get('packed') ?? 0) + (by.get('shipped') ?? 0),
    total: rows.reduce((sum, r) => sum + r.count, 0),
  };
}
