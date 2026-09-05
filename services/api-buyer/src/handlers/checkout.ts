import { AppError, groupByMerchant, type CartItem, type Clock } from '@catalograil/core';
import {
  merchantPolicies,
  merchants,
  orderEvents,
  orderItems,
  orders,
  productVariants,
  products,
  type Database,
} from '@catalograil/db';
import { createRazorpayOrder, getRazorpayClient, type RazorpayClientDeps } from '@catalograil/razorpay';
import { and, eq, sql } from 'drizzle-orm';

/**
 * T2.15 — turning a cart into payable orders, one per merchant.
 *
 * The sequence matters and is the reason this is one function rather than several: stock is
 * reserved *before* the payment object exists, and the payment object is created on the
 * merchant's own account. Reversing those means a buyer can pay for something that has
 * already sold out, which is a refund and an apology rather than a failed checkout.
 */

export interface CheckoutDeps extends RazorpayClientDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly fetcher?: typeof fetch;
}

export interface MerchantOrderResult {
  readonly merchantId: string;
  readonly merchantName: string;
  readonly ok: boolean;
  readonly orderId?: string;
  readonly orderNumber?: string;
  readonly razorpayOrderId?: string;
  /**
   * The merchant's **publishable** key id, which the Razorpay widget needs to open.
   *
   * `rzp_test_…` / `rzp_live_…` is designed to be public — it identifies the account to
   * Razorpay's own checkout script and authorises nothing on its own. The secret it pairs
   * with never leaves the Lambda. Without this the browser has an order it cannot pay for.
   */
  readonly razorpayKeyId?: string;
  readonly amountPaise?: string;
  readonly currency?: string;
  /** Present on failure, naming what the buyer or merchant can do about it. */
  readonly error?: string;
  readonly errorCode?: string;
}

/**
 * A per-merchant result list, never a single success or failure.
 *
 * T2.21: if merchant A succeeds and B fails, the buyer keeps A's order and retries B alone.
 * A function that threw on the first failure would force the caller to roll back a payment
 * that already worked, which is the one thing that must never happen.
 */
export async function createOrders(
  deps: CheckoutDeps,
  input: {
    cart: readonly CartItem[];
    buyerEmail: string;
    buyerPhone?: string;
    buyerId?: string;
    shippingAddress: Record<string, unknown>;
    sessionId: string;
    source: string;
  },
): Promise<{ results: MerchantOrderResult[] }> {
  const groups = groupByMerchant(input.cart);
  const results: MerchantOrderResult[] = [];

  for (const [merchantId, items] of groups) {
    try {
      results.push(await createOneMerchantOrder(deps, merchantId, items, input));
    } catch (err) {
      const appError = AppError.from(err);
      const [merchant] = await deps.db
        .select({ name: merchants.businessName })
        .from(merchants)
        .where(eq(merchants.id, merchantId))
        .limit(1);

      results.push({
        merchantId,
        merchantName: merchant?.name ?? 'this merchant',
        ok: false,
        // Named, because "payment failed" on a two-merchant cart tells the buyer nothing
        // about which half to retry.
        error: appError.message,
        errorCode: appError.code,
      });
    }
  }

  return { results };
}

async function createOneMerchantOrder(
  deps: CheckoutDeps,
  merchantId: string,
  items: readonly CartItem[],
  input: {
    buyerEmail: string;
    buyerPhone?: string;
    buyerId?: string;
    shippingAddress: Record<string, unknown>;
    sessionId: string;
    source: string;
  },
): Promise<MerchantOrderResult> {
  const [merchant] = await deps.db
    .select({ id: merchants.id, name: merchants.businessName, status: merchants.status })
    .from(merchants)
    .where(eq(merchants.id, merchantId))
    .limit(1);

  if (!merchant) throw new AppError('NOT_FOUND', 'No such merchant.');
  if (merchant.status !== 'active') {
    throw new AppError('MERCHANT_SUSPENDED', `${merchant.name} is not accepting orders.`);
  }

  /**
   * The merchant's credentials are resolved *first*.
   *
   * Reserving stock and then discovering the merchant cannot take payment leaves stock held
   * against an order that can never complete, and the sweeper only releases it twenty
   * minutes later.
   */
  const client = await getRazorpayClient(deps, merchantId);

  const now = deps.clock.now();
  const orderNumber = generateOrderNumber();
  let subtotal = 0n;

  const reserved: { variantId: string; quantity: number }[] = [];
  const lineItems: {
    productId: string;
    variantId: string | null;
    name: string;
    sku: string;
    options: Record<string, unknown>;
    unitPricePaise: bigint;
    quantity: number;
  }[] = [];

  /**
   * Reservation and validation in one transaction, so a concurrent buyer cannot slip
   * between the check and the decrement.
   */
  await deps.db.transaction(async (tx) => {
    for (const item of items) {
      const [row] = await tx
        .select({
          variantId: productVariants.id,
          sku: productVariants.sku,
          optionValues: productVariants.optionValues,
          pricePaise: productVariants.pricePaise,
          status: productVariants.status,
          productName: products.name,
          productStatus: products.status,
        })
        .from(productVariants)
        .innerJoin(products, eq(products.id, productVariants.productId))
        .where(
          item.variantId
            ? eq(productVariants.id, item.variantId)
            : eq(productVariants.productId, item.productId),
        )
        .limit(1);

      if (!row || row.status !== 'active' || row.productStatus === 'archived') {
        throw new AppError('NOT_FOUND', 'That item is no longer available.');
      }

      /**
       * The price is re-checked against the cart snapshot.
       *
       * A buyer quoted ₹1,999 and charged ₹2,199 has been defrauded however innocent the
       * cause, so a moved price stops the checkout and asks them to look again rather than
       * quietly charging the new one.
       */
      const current = row.pricePaise ?? 0n;
      if (current.toString() !== item.priceSnapshot) {
        throw new AppError(
          'PRICE_MOVED',
          `The price of ${row.productName} changed while you were deciding.`,
          { details: { was: item.priceSnapshot, now: current.toString() } },
        );
      }

      /**
       * The reservation, and the whole reason this is a conditional UPDATE.
       *
       * `WHERE stock >= qty ... RETURNING` makes the check and the decrement one atomic
       * step. Three buyers racing for one unit all read `stock = 1`, and exactly one of
       * their updates matches the predicate — the other two get zero rows back and are told
       * they were too slow, rather than all three succeeding and one being disappointed
       * after paying.
       */
      const taken = await tx
        .update(productVariants)
        .set({ stock: sql`${productVariants.stock} - ${item.quantity}` })
        .where(
          and(
            eq(productVariants.id, row.variantId),
            sql`${productVariants.stock} >= ${item.quantity}`,
          ),
        )
        .returning({ id: productVariants.id });

      if (taken.length === 0) {
        throw new AppError(
          'INSUFFICIENT_STOCK',
          `${row.productName} sold out while you were checking out.`,
        );
      }

      reserved.push({ variantId: row.variantId, quantity: item.quantity });
      subtotal += current * BigInt(item.quantity);
      lineItems.push({
        productId: item.productId,
        variantId: row.variantId,
        name: row.productName,
        sku: row.sku,
        options: (row.optionValues ?? {}) as Record<string, unknown>,
        unitPricePaise: current,
        quantity: item.quantity,
      });
    }
  });

  try {
    const razorpayOrder = await createRazorpayOrder(
      client,
      {
        amountPaise: subtotal,
        receipt: orderNumber,
        notes: { order_number: orderNumber, buyer_email: input.buyerEmail },
      },
      deps.fetcher,
    );

    /**
     * Rule 4 — the merchant's policies are copied onto the order.
     *
     * Policies change; the contract a buyer agreed to does not. Reading them at dispute
     * time would show today's terms rather than the ones they bought under.
     */
    const [policy] = await deps.db
      .select()
      .from(merchantPolicies)
      .where(eq(merchantPolicies.merchantId, merchantId))
      .limit(1);

    const [created] = await deps.db
      .insert(orders)
      .values({
        orderNumber,
        ...(input.buyerId ? { buyerId: input.buyerId } : {}),
        buyerEmail: input.buyerEmail,
        ...(input.buyerPhone ? { buyerPhone: input.buyerPhone } : {}),
        merchantId,
        shippingAddress: input.shippingAddress as never,
        subtotalPaise: subtotal,
        shippingPaise: 0n,
        taxPaise: 0n,
        totalPaise: subtotal,
        status: 'awaiting_payment',
        razorpayOrderId: razorpayOrder.id,
        source: input.source as never,
        sessionId: input.sessionId,
        policySnapshot: (policy
          ? {
              refundSummary: policy.refundSummary,
              termsSummary: policy.termsSummary,
              fulfillmentSummary: policy.fulfillmentSummary,
              returnWindowDays: policy.returnWindowDays,
              returnShippingBy: policy.returnShippingBy,
              dispatchSlaHours: policy.dispatchSlaHours,
              capturedAt: now.toISOString(),
            }
          : null) as never,
      })
      .returning({ id: orders.id });

    await deps.db.insert(orderItems).values(
      lineItems.map((line) => ({
        orderId: created!.id,
        productId: line.productId,
        variantId: line.variantId,
        nameSnapshot: line.name,
        skuSnapshot: line.sku,
        optionsSnapshot: line.options as never,
        unitPricePaise: line.unitPricePaise,
        quantity: line.quantity,
        lineTotalPaise: line.unitPricePaise * BigInt(line.quantity),
      })),
    );

    await deps.db.insert(orderEvents).values({
      orderId: created!.id,
      eventType: 'order.created',
      actor: 'system',
      payload: { razorpayOrderId: razorpayOrder.id, merchantId } as never,
    });

    return {
      merchantId,
      merchantName: merchant.name,
      ok: true,
      orderId: created!.id,
      orderNumber,
      razorpayOrderId: razorpayOrder.id,
      razorpayKeyId:
        client.connection.method === 'api_keys' ? client.connection.keyId : undefined,
      amountPaise: subtotal.toString(),
      currency: razorpayOrder.currency,
    };
  } catch (err) {
    /**
     * Payment object creation failed after stock was reserved, so it is released now rather
     * than left for the sweeper.
     *
     * Twenty minutes of phantom scarcity for an error we already know about would make a
     * merchant's last unit unbuyable because someone else's card form timed out.
     */
    await releaseReservations(deps.db, reserved).catch(() => {
      // If the release fails the sweeper still catches it; losing the original error to a
      // cleanup failure would be worse.
    });
    throw err;
  }
}

export async function releaseReservations(
  db: Database,
  reserved: readonly { variantId: string; quantity: number }[],
): Promise<void> {
  for (const item of reserved) {
    await db
      .update(productVariants)
      .set({ stock: sql`${productVariants.stock} + ${item.quantity}` })
      .where(eq(productVariants.id, item.variantId));
  }
}

/**
 * Human-readable and unambiguous when read aloud.
 *
 * No I, O, 0 or 1: a merchant reading an order number off a phone call should not have to
 * ask whether that was a one or an ell.
 */
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export function generateOrderNumber(): string {
  let suffix = '';
  for (let i = 0; i < 6; i++) {
    suffix += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return `ORD-${suffix}`;
}
