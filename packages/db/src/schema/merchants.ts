import { MERCHANT_CAPABILITIES, MERCHANT_STATUSES } from '@catalograil/core';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  uuid, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, inList, tstz, updatedAt } from './_shared.js';

export const merchants = pgTable(
  'merchants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessName: text('business_name').notNull(),
    legalName: text('legal_name'),
    /**
     * Unique, because under DC1 this is the identity anchor.
     *
     * Cognito's merchant pool signs in by email, and the post-confirmation trigger
     * attaches a confirming user to an existing merchant by conflicting on this column —
     * which is what lets a seeded or previously-created merchant keep its catalogue
     * instead of being orphaned behind a duplicate account. Without the constraint that
     * upsert has nothing to match and the whole sign-up fails.
     */
    contactEmail: text('contact_email').notNull(),
    /**
     * The Cognito user's `sub` (DC1).
     *
     * Nullable because identity and payment connection are now separate concerns: a
     * merchant row can exist before a Cognito user does — seeded catalogues and the rows
     * the old Razorpay OAuth flow created both predate one — and S2.4 backfills them.
     * Unique, so two Cognito users can never resolve to the same merchant.
     */
    cognitoSub: text('cognito_sub'),
    contactPhone: text('contact_phone'),
    gstin: text('gstin'),
    gstinVerified: boolean('gstin_verified').default(false).notNull(),
    razorpayAccountId: text('razorpay_account_id').unique(),
    status: text('status').default('pending').notNull(),
    categories: text('categories').array(),
    city: text('city'),
    state: text('state'),
    onboardedAt: tstz('onboarded_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('merchants_status_created_idx').on(t.status, t.createdAt),
    uniqueIndex('merchants_cognito_sub_key').on(t.cognitoSub),
    uniqueIndex('merchants_contact_email_key').on(t.contactEmail),
    check('merchants_status_check', sql`${t.status} IN (${inList(MERCHANT_STATUSES)})`),
  ],
);

export const merchantCapabilities = pgTable(
  'merchant_capabilities',
  {
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    capability: text('capability').notNull(),
    /** Endpoint URLs, auth references and schema hints for live/bookable/quote adapters. */
    config: jsonb('config').$type<Record<string, unknown>>(),
    enabled: boolean('enabled').default(true).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.merchantId, t.capability] }),
    check(
      'merchant_capabilities_capability_check',
      sql`${t.capability} IN (${inList(MERCHANT_CAPABILITIES)})`,
    ),
  ],
);

/**
 * Rule 3: never store a Razorpay token unencrypted. Both token columns hold a KMS
 * envelope-encrypted payload and are decrypted in memory only — see
 * `@catalograil/razorpay`. Nothing outside that package should read them.
 */
/**
 * S3.1 — how a merchant's Razorpay account is connected (DC2).
 *
 * Two methods behind one row. API keys are what merchants can use today; OAuth is what
 * Partner approval unlocks later, and `merchant_tokens` still holds those. Everything
 * downstream resolves through `getRazorpayClient(merchantId)`, so adding the OAuth branch
 * changes this table and nothing else.
 *
 * The secret is KMS envelope-encrypted at rest and never leaves this table in plaintext.
 * `key_secret_last4` exists precisely so the dashboard never needs the real value to show
 * a merchant which key is connected.
 */
export const merchantPaymentConfig = pgTable('merchant_payment_config', {
  merchantId: uuid('merchant_id')
    .primaryKey()
    .references(() => merchants.id, { onDelete: 'cascade' }),
  /** api_keys | oauth */
  method: text('method').notNull().default('api_keys'),
  /** `rzp_test_...` or `rzp_live_...`. Not secret; identifies the key and its mode. */
  keyId: text('key_id'),
  /** KMS ciphertext. Decrypted in memory only, for the duration of one invocation. */
  keySecretEncrypted: text('key_secret_encrypted'),
  keySecretLast4: text('key_secret_last4'),
  webhookSecretEncrypted: text('webhook_secret_encrypted'),
  /** test | live, derived from the key prefix rather than asked for — merchants mistype it. */
  mode: text('mode'),
  /** unverified | verified | invalid */
  status: text('status').notNull().default('unverified'),
  verifiedAt: tstz('verified_at'),
  /** Why the last verification failed, for the dashboard to show. Never a credential. */
  lastError: text('last_error'),
  updatedAt: updatedAt(),
});

export const merchantTokens = pgTable(
  'merchant_tokens',
  {
    merchantId: uuid('merchant_id')
      .primaryKey()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    accessToken: text('access_token').notNull(),
    refreshToken: text('refresh_token').notNull(),
    accessExpiresAt: tstz('access_expires_at').notNull(),
    refreshExpiresAt: tstz('refresh_expires_at').notNull(),
    scopes: text('scopes').array(),
    lastRefreshedAt: tstz('last_refreshed_at'),
    /** Consecutive refresh failures. At 3 the merchant is suspended (T1.7). */
    refreshFailures: integer('refresh_failures').default(0).notNull(),
  },
  // The refresh worker scans this daily for tokens nearing expiry.
  (t) => [index('merchant_tokens_access_expires_idx').on(t.accessExpiresAt)],
);

export const merchantPolicies = pgTable('merchant_policies', {
  merchantId: uuid('merchant_id')
    .primaryKey()
    .references(() => merchants.id, { onDelete: 'cascade' }),
  /** Mandatory — a merchant cannot reach `active` without all three (T1.9). */
  refundUrl: text('refund_url').notNull(),
  termsUrl: text('terms_url').notNull(),
  fulfillmentUrl: text('fulfillment_url').notNull(),
  refundSummary: text('refund_summary'),
  termsSummary: text('terms_summary'),
  fulfillmentSummary: text('fulfillment_summary'),
  returnWindowDays: integer('return_window_days'),
  /** buyer | merchant | conditional */
  returnShippingBy: text('return_shipping_by'),
  dispatchSlaHours: integer('dispatch_sla_hours'),
  lastCheckedAt: tstz('last_checked_at'),
  /** ok | unreachable | empty | changed */
  lastCheckStatus: text('last_check_status'),
  consecutiveFailures: integer('consecutive_failures').default(0).notNull(),
});

/** Recomputed nightly by the metrics worker. Never written from a request path. */
export const merchantMetrics = pgTable('merchant_metrics', {
  merchantId: uuid('merchant_id')
    .primaryKey()
    .references(() => merchants.id, { onDelete: 'cascade' }),
  ordersTotal: integer('orders_total').default(0).notNull(),
  ordersFulfilled: integer('orders_fulfilled').default(0).notNull(),
  ordersCancelled: integer('orders_cancelled').default(0).notNull(),
  onTimeDeliveries: integer('on_time_deliveries').default(0).notNull(),
  avgRating: numeric('avg_rating', { precision: 3, scale: 2 }),
  ratingCount: integer('rating_count').default(0).notNull(),
  avgAckMinutes: integer('avg_ack_minutes'),
  disputeCount: integer('dispute_count').default(0).notNull(),
  verificationScore: numeric('verification_score', { precision: 4, scale: 3 }),
  trustScore: numeric('trust_score', { precision: 4, scale: 3 }),
  /** Caps this merchant's trust contribution in re-rank (never-do #3). */
  isNewMerchant: boolean('is_new_merchant').default(true).notNull(),
  computedAt: tstz('computed_at'),
});
