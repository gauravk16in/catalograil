import { AppError, type Clock } from '@catalograil/core';
import { merchantPaymentConfig, merchants, type Database } from '@catalograil/db';
import {
  getPaymentConfigSummary,
  last4,
  testWebhookSecret,
  validateKeyFormat,
  verifyApiKeys,
  type Fetcher,
  type PaymentConfigSummary,
  type TokenCipher,
} from '@catalograil/razorpay';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

/**
 * S3.2/S3.3 — connect, verify, and disconnect a merchant's Razorpay account.
 *
 * The ordering rule for the whole file: **verify before storing**. A rejected key leaves
 * no row, so there is never a half-connected state where the dashboard says one thing and
 * checkout does another.
 */

const connectSchema = z
  .object({
    keyId: z.string().trim().min(1).max(120),
    keySecret: z.string().trim().min(1).max(200),
    /** Optional: a merchant can add it later from the same screen. */
    webhookSecret: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export interface PaymentConfigDeps {
  readonly db: Database;
  readonly cipherFor: (merchantId: string) => TokenCipher;
  readonly clock: Clock;
  readonly fetcher?: Fetcher;
  /** The platform environment, so live keys in dev can be refused rather than warned about. */
  readonly stage: string;
}

export async function connectPaymentConfig(
  deps: PaymentConfigDeps,
  merchantId: string,
  body: unknown,
): Promise<PaymentConfigSummary> {
  const parsed = connectSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 'Key id and secret are required.', {
      details: { issues: parsed.error.issues },
    });
  }
  const { keyId, keySecret, webhookSecret } = parsed.data;

  // Format first: a typo should not cost a round trip to Razorpay.
  const mode = validateKeyFormat(keyId);

  /**
   * Live keys are refused outside production, not merely flagged.
   *
   * A merchant who pastes live keys into a dev environment is one test order away from a
   * real charge on a real card. S3.2 says warn loudly; refusing is the version of that
   * which cannot be clicked past, and the message says exactly what to do instead.
   */
  if (mode === 'live' && deps.stage !== 'prod') {
    throw new AppError(
      'VALIDATION_FAILED',
      `These are live keys and this is the ${deps.stage} environment, where a test order ` +
        'would take real money. Use your rzp_test_ keys here.',
    );
  }

  const result = await verifyApiKeys(keyId, keySecret, deps.fetcher);
  if (!result.ok) {
    /**
     * Nothing is written on failure — not even the error.
     *
     * Recording a failed attempt against a merchant who is currently connected and working
     * would flip their status to invalid on a typo, and search excludes merchants whose
     * payment config is not verified.
     */
    throw new AppError('PAYMENT_CONFIG_INVALID', result.error ?? 'Razorpay rejected these keys.');
  }

  const cipher = deps.cipherFor(merchantId);
  const now = deps.clock.now();

  await deps.db
    .insert(merchantPaymentConfig)
    .values({
      merchantId,
      method: 'api_keys',
      keyId,
      keySecretEncrypted: await cipher.encrypt(keySecret),
      keySecretLast4: last4(keySecret),
      ...(webhookSecret ? { webhookSecretEncrypted: await cipher.encrypt(webhookSecret) } : {}),
      mode,
      status: 'verified',
      verifiedAt: now,
      lastError: null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: merchantPaymentConfig.merchantId,
      set: {
        method: 'api_keys',
        keyId,
        keySecretEncrypted: await cipher.encrypt(keySecret),
        keySecretLast4: last4(keySecret),
        ...(webhookSecret ? { webhookSecretEncrypted: await cipher.encrypt(webhookSecret) } : {}),
        mode,
        status: 'verified',
        verifiedAt: now,
        lastError: null,
        updatedAt: now,
      },
    });

  const summary = await getPaymentConfigSummary(deps.db, merchantId);
  if (!summary) throw new AppError('INTERNAL_ERROR', 'Payment config vanished after writing it.');
  return summary;
}

export async function readPaymentConfig(
  db: Database,
  merchantId: string,
): Promise<PaymentConfigSummary | { status: 'not_connected' }> {
  const summary = await getPaymentConfigSummary(db, merchantId);
  return summary ?? { status: 'not_connected' };
}

/**
 * Disconnecting also suspends the merchant.
 *
 * A merchant with no way to take payment must not stay in search: a buyer who reaches
 * checkout and cannot pay has had a worse experience than one who never saw the product.
 * The T1.16 trigger propagates the status change into `searchable_units`.
 */
export async function disconnectPaymentConfig(
  deps: PaymentConfigDeps,
  merchantId: string,
): Promise<{ disconnected: boolean; merchantStatus: string }> {
  await deps.db
    .delete(merchantPaymentConfig)
    .where(eq(merchantPaymentConfig.merchantId, merchantId));

  await deps.db
    .update(merchants)
    .set({ status: 'pending', updatedAt: deps.clock.now() })
    .where(eq(merchants.id, merchantId));

  return { disconnected: true, merchantStatus: 'pending' };
}

/**
 * S3.3 — check the stored webhook secret round-trips.
 *
 * It signs a sample payload and verifies it back, which catches a pasted secret with a
 * stray space or a truncated copy. It cannot prove Razorpay has the same secret — only a
 * real delivery does that — and the response says so rather than implying more.
 */
export async function testWebhook(
  deps: PaymentConfigDeps,
  merchantId: string,
): Promise<{ ok: boolean; detail: string }> {
  const [row] = await deps.db
    .select({ secret: merchantPaymentConfig.webhookSecretEncrypted })
    .from(merchantPaymentConfig)
    .where(eq(merchantPaymentConfig.merchantId, merchantId))
    .limit(1);

  if (!row?.secret) {
    return { ok: false, detail: 'No webhook secret is saved yet.' };
  }

  const secret = await deps.cipherFor(merchantId).decrypt(row.secret);
  const { ok } = testWebhookSecret(secret);

  return {
    ok,
    detail: ok
      ? 'The saved secret signs and verifies correctly. Razorpay must be configured with the same value.'
      : 'The saved secret did not verify. Paste it again from your Razorpay dashboard.',
  };
}

/** The URL a merchant registers in their Razorpay dashboard (S3.3). */
export function webhookUrlFor(apiBaseUrl: string, merchantId: string): string {
  return `${apiBaseUrl.replace(/\/$/, '')}/webhooks/razorpay/${merchantId}`;
}
