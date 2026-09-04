import { AppError } from '@catalograil/core';
import { merchantPaymentConfig, merchantTokens, type Database } from '@catalograil/db';
import { eq } from 'drizzle-orm';
import type { TokenCipher } from './tokens.js';

/**
 * S3.4 — one door to a merchant's Razorpay account (DC2).
 *
 * Two connection methods, one interface. API keys are what a merchant can use today;
 * OAuth is what Partner approval unlocks later. Everything downstream — orders, payment
 * links, refunds, webhook verification — resolves through `getRazorpayClient(merchantId)`,
 * so the OAuth branch lands here and changes nothing else.
 *
 * The decrypted secret is returned inside the client and never stored, cached across
 * invocations, or written to DynamoDB. Lambda freezes between invocations rather than
 * exiting, so a module-level cache of a decrypted credential would outlive the request
 * that was entitled to it.
 */

export type RazorpayConnection =
  | { readonly method: 'api_keys'; readonly keyId: string; readonly keySecret: string }
  | { readonly method: 'oauth'; readonly accessToken: string; readonly refreshToken: string };

export interface RazorpayClient {
  readonly merchantId: string;
  readonly mode: 'test' | 'live';
  readonly connection: RazorpayConnection;
  /** Authorization header for a direct call to the Razorpay API. */
  authHeader(): string;
}

export interface PaymentConfigSummary {
  readonly method: string;
  readonly keyId: string | null;
  readonly keySecretLast4: string | null;
  readonly mode: string | null;
  readonly status: string;
  readonly verifiedAt: string | null;
  readonly lastError: string | null;
  readonly webhookConfigured: boolean;
}

export interface RazorpayClientDeps {
  readonly db: Database;
  readonly cipherFor: (merchantId: string) => TokenCipher;
}

export async function getRazorpayClient(
  deps: RazorpayClientDeps,
  merchantId: string,
): Promise<RazorpayClient> {
  const [config] = await deps.db
    .select()
    .from(merchantPaymentConfig)
    .where(eq(merchantPaymentConfig.merchantId, merchantId))
    .limit(1);

  if (!config) {
    throw new AppError('PAYMENT_CONFIG_MISSING', 'This merchant has not connected Razorpay yet.');
  }

  if (config.status !== 'verified') {
    /**
     * Unverified is refused, not attempted.
     *
     * Trying anyway turns a known-bad credential into a failed checkout in front of a
     * buyer. Rule 15's reasoning applies to keys as much as to tokens: a merchant who
     * cannot take payment is excluded from search rather than discovered at the till.
     */
    throw new AppError(
      'PAYMENT_CONFIG_INVALID',
      `Razorpay credentials for this merchant are ${config.status}.`,
    );
  }

  if (config.method === 'oauth') {
    const [tokens] = await deps.db
      .select()
      .from(merchantTokens)
      .where(eq(merchantTokens.merchantId, merchantId))
      .limit(1);

    if (!tokens) {
      throw new AppError('PAYMENT_CONFIG_MISSING', 'No OAuth tokens for this merchant.');
    }
    if (tokens.accessExpiresAt.getTime() <= Date.now()) {
      // Rule 15: an expired token means exclusion, not a hopeful call.
      throw new AppError('MERCHANT_TOKEN_EXPIRED', 'The merchant’s Razorpay token has expired.');
    }

    const cipher = deps.cipherFor(merchantId);
    const accessToken = await cipher.decrypt(tokens.accessToken);
    const refreshToken = await cipher.decrypt(tokens.refreshToken);

    return {
      merchantId,
      mode: (config.mode as 'test' | 'live') ?? 'test',
      connection: { method: 'oauth', accessToken, refreshToken },
      authHeader: () => `Bearer ${accessToken}`,
    };
  }

  if (!config.keyId || !config.keySecretEncrypted) {
    throw new AppError('PAYMENT_CONFIG_MISSING', 'Razorpay key id or secret is missing.');
  }

  const keySecret = await deps.cipherFor(merchantId).decrypt(config.keySecretEncrypted);

  return {
    merchantId,
    mode: (config.mode as 'test' | 'live') ?? modeFromKeyId(config.keyId),
    connection: { method: 'api_keys', keyId: config.keyId, keySecret },
    authHeader: () => `Basic ${Buffer.from(`${config.keyId}:${keySecret}`).toString('base64')}`,
  };
}

/** The merchant's webhook secret, for verifying a signature. Decrypted per call. */
export async function getWebhookSecret(
  deps: RazorpayClientDeps,
  merchantId: string,
): Promise<string | null> {
  const [config] = await deps.db
    .select({ secret: merchantPaymentConfig.webhookSecretEncrypted })
    .from(merchantPaymentConfig)
    .where(eq(merchantPaymentConfig.merchantId, merchantId))
    .limit(1);

  if (!config?.secret) return null;
  return deps.cipherFor(merchantId).decrypt(config.secret);
}

/**
 * What the dashboard is allowed to see.
 *
 * There is no code path that returns `key_secret_encrypted` or its plaintext to any API
 * response — the shape of this function is the guarantee, which is why it selects columns
 * explicitly rather than spreading a row.
 */
export async function getPaymentConfigSummary(
  db: Database,
  merchantId: string,
): Promise<PaymentConfigSummary | null> {
  const [row] = await db
    .select({
      method: merchantPaymentConfig.method,
      keyId: merchantPaymentConfig.keyId,
      keySecretLast4: merchantPaymentConfig.keySecretLast4,
      mode: merchantPaymentConfig.mode,
      status: merchantPaymentConfig.status,
      verifiedAt: merchantPaymentConfig.verifiedAt,
      lastError: merchantPaymentConfig.lastError,
      webhookSecretEncrypted: merchantPaymentConfig.webhookSecretEncrypted,
    })
    .from(merchantPaymentConfig)
    .where(eq(merchantPaymentConfig.merchantId, merchantId))
    .limit(1);

  if (!row) return null;

  return {
    method: row.method,
    keyId: row.keyId,
    keySecretLast4: row.keySecretLast4,
    mode: row.mode,
    status: row.status,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    lastError: row.lastError,
    // A boolean, not the value: whether a webhook secret exists is useful, what it is is not.
    webhookConfigured: Boolean(row.webhookSecretEncrypted),
  };
}

export function modeFromKeyId(keyId: string): 'test' | 'live' {
  return keyId.startsWith('rzp_live_') ? 'live' : 'test';
}

/** Last four characters, which is all the dashboard ever shows. */
export function last4(secret: string): string {
  return secret.slice(-4);
}
