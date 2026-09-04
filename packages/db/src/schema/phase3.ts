import { ADAPTER_TIMEOUT_MS, MERCHANT_CAPABILITIES } from '@catalograil/core';
import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, inList, tstz } from './_shared.js';
import { merchants } from './merchants.js';

/**
 * Created in Phase 1, used in Phase 3. Retrofitting these later is a full migration
 * — `products.adapter_id` and `order_items.slot_id` already point here.
 */

export const adapters = pgTable(
  'adapters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    capability: text('capability').notNull(),
    baseUrl: text('base_url').notNull(),
    /** none | bearer | hmac | basic */
    authType: text('auth_type').notNull(),
    /** A Secrets Manager ARN or SSM path — never the credential itself (never-do #4). */
    authRef: text('auth_ref'),
    timeoutMs: integer('timeout_ms').default(ADAPTER_TIMEOUT_MS).notNull(),
    /** healthy | degraded | unhealthy */
    healthStatus: text('health_status').default('healthy').notNull(),
    consecutiveFailures: integer('consecutive_failures').default(0).notNull(),
    /** Rule 12: the breaker opens at 3 consecutive failures. */
    circuitOpenUntil: tstz('circuit_open_until'),
    lastHealthCheckAt: tstz('last_health_check_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('adapters_merchant_idx').on(t.merchantId),
    check('adapters_capability_check', sql`${t.capability} IN (${inList(MERCHANT_CAPABILITIES)})`),
  ],
);

/** A bookable offering's calendar: a cinema seat block, a hotel night, a doctor's slot. */
export const slots = pgTable(
  'slots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id').notNull(),
    adapterId: uuid('adapter_id').references(() => adapters.id),
    startsAt: tstz('starts_at').notNull(),
    endsAt: tstz('ends_at'),
    capacity: integer('capacity').notNull(),
    booked: integer('booked').default(0).notNull(),
    pricePaise: bigint('price_paise', { mode: 'bigint' }),
    location: jsonb('location').$type<Record<string, unknown>>(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    /** open | full | cancelled */
    status: text('status').default('open').notNull(),
  },
  (t) => [
    index('slots_product_starts_idx').on(t.productId, t.startsAt),
    check('slots_booked_within_capacity', sql`${t.booked} >= 0 AND ${t.booked} <= ${t.capacity}`),
  ],
);

/** A short-lived reservation while the buyer pays. Swept on expiry (T2.17). */
export const slotHolds = pgTable(
  'slot_holds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slotId: uuid('slot_id')
      .notNull()
      .references(() => slots.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').notNull(),
    quantity: integer('quantity').notNull(),
    expiresAt: tstz('expires_at').notNull(),
    /** held | confirmed | released | expired */
    status: text('status').default('held').notNull(),
  },
  (t) => [
    // The sweeper scans this.
    index('slot_holds_expires_idx').on(t.expiresAt),
    index('slot_holds_slot_idx').on(t.slotId),
  ],
);

export const quotations = pgTable(
  'quotations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id').notNull(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    buyerId: uuid('buyer_id'),
    buyerEmail: text('buyer_email').notNull(),
    rfqPayload: jsonb('rfq_payload').$type<Record<string, unknown>>().notNull(),
    status: text('status').default('requested').notNull(),
    quotedAmountPaise: bigint('quoted_amount_paise', { mode: 'bigint' }),
    quotedNotes: text('quoted_notes'),
    validUntil: tstz('valid_until'),
    razorpayOrderId: text('razorpay_order_id'),
    createdAt: createdAt(),
    respondedAt: tstz('responded_at'),
  },
  (t) => [
    index('quotations_merchant_status_idx').on(t.merchantId, t.status),
    check(
      'quotations_status_check',
      sql`${t.status} IN ('requested', 'quoted', 'accepted', 'expired', 'declined')`,
    ),
  ],
);
