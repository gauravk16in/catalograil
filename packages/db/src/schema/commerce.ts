import {
  ORDER_SOURCES,
  ORDER_STATUSES,
  type OrderSource,
  type OrderStatus,
} from '@catalograil/core';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { products, productVariants } from './catalog.js';
import { createdAt, inList, tstz, updatedAt } from './_shared.js';
import { merchants } from './merchants.js';
import { slots } from './phase3.js';

export const buyers = pgTable(
  'buyers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name'),
    email: text('email'),
    phone: text('phone'),
    emailVerified: boolean('email_verified').default(false).notNull(),
    phoneVerified: boolean('phone_verified').default(false).notNull(),
    defaultAddressId: uuid('default_address_id'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('buyers_email_key').on(t.email), uniqueIndex('buyers_phone_key').on(t.phone)],
);

export const buyerAddresses = pgTable(
  'buyer_addresses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    buyerId: uuid('buyer_id')
      .notNull()
      .references(() => buyers.id, { onDelete: 'cascade' }),
    label: text('label'),
    recipientName: text('recipient_name').notNull(),
    recipientPhone: text('recipient_phone').notNull(),
    line1: text('line1').notNull(),
    line2: text('line2'),
    landmark: text('landmark'),
    city: text('city').notNull(),
    state: text('state').notNull(),
    pincode: text('pincode').notNull(),
    country: text('country').default('IN').notNull(),
    deliveryNotes: text('delivery_notes'),
    isDefault: boolean('is_default').default(false).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('buyer_addresses_buyer_idx').on(t.buyerId)],
);

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Human-readable, e.g. ORD-2K4M9X. What a buyer quotes in a support message. */
    orderNumber: text('order_number').notNull().unique(),
    /** Null for a guest checkout; linked later if they sign up (T2.25). */
    buyerId: uuid('buyer_id').references(() => buyers.id),
    buyerEmail: text('buyer_email').notNull(),
    buyerPhone: text('buyer_phone'),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    /** A snapshot, not an FK — the address the buyer used must not change under them. */
    shippingAddress: jsonb('shipping_address').$type<Record<string, unknown>>(),
    subtotalPaise: bigint('subtotal_paise', { mode: 'bigint' }).notNull(),
    shippingPaise: bigint('shipping_paise', { mode: 'bigint' })
      .default(sql`0`)
      .notNull(),
    taxPaise: bigint('tax_paise', { mode: 'bigint' })
      .default(sql`0`)
      .notNull(),
    totalPaise: bigint('total_paise', { mode: 'bigint' }).notNull(),
    status: text('status').$type<OrderStatus>().default('awaiting_payment').notNull(),
    /** D4: these objects live on the merchant's Razorpay account, not ours. */
    razorpayOrderId: text('razorpay_order_id'),
    razorpayPaymentId: text('razorpay_payment_id'),
    paymentLinkUrl: text('payment_link_url'),
    paymentExpiresAt: tstz('payment_expires_at'),
    source: text('source').$type<OrderSource>().notNull(),
    sessionId: text('session_id'),
    /**
     * Rule 4: the merchant's policies as they stood at purchase time. Policies change;
     * the buyer's contract does not.
     */
    policySnapshot: jsonb('policy_snapshot').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('orders_merchant_created_idx').on(t.merchantId, t.createdAt),
    index('orders_buyer_email_created_idx').on(t.buyerEmail, t.createdAt),
    index('orders_status_created_idx').on(t.status, t.createdAt),
    index('orders_razorpay_order_idx').on(t.razorpayOrderId),
    check('orders_status_check', sql`${t.status} IN (${inList(ORDER_STATUSES)})`),
    check('orders_source_check', sql`${t.source} IN (${inList(ORDER_SOURCES)})`),
    check('orders_total_positive', sql`${t.totalPaise} > 0`),
  ],
);

/**
 * Line items carry snapshots of everything the buyer saw. A later price or name change
 * on the product must not rewrite history.
 */
export const orderItems = pgTable(
  'order_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    productId: uuid('product_id').references(() => products.id),
    variantId: uuid('variant_id').references(() => productVariants.id),
    slotId: uuid('slot_id').references(() => slots.id),
    nameSnapshot: text('name_snapshot').notNull(),
    skuSnapshot: text('sku_snapshot'),
    optionsSnapshot: jsonb('options_snapshot').$type<Record<string, string>>(),
    unitPricePaise: bigint('unit_price_paise', { mode: 'bigint' }).notNull(),
    quantity: integer('quantity').notNull(),
    lineTotalPaise: bigint('line_total_paise', { mode: 'bigint' }).notNull(),
    promisedDeliveryDate: tstz('promised_delivery_date'),
  },
  (t) => [
    index('order_items_order_idx').on(t.orderId),
    check('order_items_quantity_positive', sql`${t.quantity} > 0`),
  ],
);

/** Append-only audit trail. Every status change and webhook lands here. */
export const orderEvents = pgTable(
  'order_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    /** merchant | buyer | system | razorpay */
    actor: text('actor').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index('order_events_order_created_idx').on(t.orderId, t.createdAt)],
);

export const reviews = pgTable(
  'reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** One review per order — the only proof of purchase we accept. */
    orderId: uuid('order_id')
      .notNull()
      .unique()
      .references(() => orders.id, { onDelete: 'cascade' }),
    buyerId: uuid('buyer_id').references(() => buyers.id),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    productId: uuid('product_id').references(() => products.id),
    rating: integer('rating').notNull(),
    title: text('title'),
    body: text('body'),
    deliveredOnTime: boolean('delivered_on_time'),
    createdAt: createdAt(),
  },
  (t) => [
    index('reviews_merchant_idx').on(t.merchantId),
    index('reviews_product_idx').on(t.productId),
    check('reviews_rating_range', sql`${t.rating} BETWEEN 1 AND 5`),
  ],
);
