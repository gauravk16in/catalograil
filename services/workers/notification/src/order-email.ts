import { formatPaise, type Mailer } from '@catalograil/core';
import { merchants, orderItems, orders, type Database } from '@catalograil/db';
import { eq } from 'drizzle-orm';

/**
 * T2.18 — telling a merchant they have been paid.
 *
 * Speed is the whole point. A merchant who learns about an order six hours late has already
 * lost the buyer's goodwill, and acknowledgement time feeds the responsiveness component of
 * their own trust score — so a slow notification costs them ranking as well as a review.
 *
 * The email contains everything needed to pack the order without opening a dashboard,
 * because a merchant reading this on a phone in a warehouse will not open one.
 */

export interface OrderNotificationDeps {
  readonly db: Database;
  readonly mailer: Mailer;
  readonly merchantAppUrl: string;
}

export async function sendOrderPaidEmail(
  deps: OrderNotificationDeps,
  orderId: string,
): Promise<{ sent: boolean; to?: string }> {
  const [order] = await deps.db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      buyerEmail: orders.buyerEmail,
      buyerPhone: orders.buyerPhone,
      shippingAddress: orders.shippingAddress,
      totalPaise: orders.totalPaise,
      status: orders.status,
      policySnapshot: orders.policySnapshot,
      merchantName: merchants.businessName,
      merchantEmail: merchants.contactEmail,
    })
    .from(orders)
    .innerJoin(merchants, eq(merchants.id, orders.merchantId))
    .where(eq(orders.id, orderId))
    .limit(1);

  if (!order) return { sent: false };

  const items = await deps.db
    .select({
      name: orderItems.nameSnapshot,
      sku: orderItems.skuSnapshot,
      quantity: orderItems.quantity,
      lineTotalPaise: orderItems.lineTotalPaise,
      options: orderItems.optionsSnapshot,
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));

  const address = (order.shippingAddress ?? {}) as Record<string, string>;
  const dispatchSla = (order.policySnapshot as { dispatchSlaHours?: number } | null)
    ?.dispatchSlaHours;

  const lines = [
    `You have a new paid order: ${order.orderNumber}`,
    '',
    ...items.map((item) => {
      const options = Object.entries((item.options ?? {}) as Record<string, string>)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
      return `  ${item.quantity} × ${item.name}${options ? ` (${options})` : ''}` +
        `  ·  ${item.sku}  ·  ${formatPaise(item.lineTotalPaise)}`;
    }),
    '',
    `Total paid: ${formatPaise(order.totalPaise)}`,
    // Stated because it is the thing merchants most often misunderstand about us.
    'This was paid into your own Razorpay account. We never held the money.',
    '',
    'Ship to:',
    `  ${address.recipientName ?? ''}`,
    `  ${[address.line1, address.line2, address.landmark].filter(Boolean).join(', ')}`,
    `  ${address.city ?? ''} ${address.state ?? ''} ${address.pincode ?? ''}`,
    `  ${address.recipientPhone ?? order.buyerPhone ?? ''}`,
    '',
    `Buyer contact: ${order.buyerEmail}`,
    '',
    dispatchSla
      ? `Your published dispatch commitment is ${dispatchSla} hours. Acknowledging quickly is the single biggest thing you control in your trust score.`
      : 'Acknowledging quickly is the single biggest thing you control in your trust score.',
    '',
    `Acknowledge it here: ${deps.merchantAppUrl.replace(/\/$/, '')}/orders`,
  ];

  await deps.mailer.send({
    to: order.merchantEmail,
    subject: `New order ${order.orderNumber} — ${formatPaise(order.totalPaise)}`,
    text: lines.join('\n'),
  });

  return { sent: true, to: order.merchantEmail };
}
