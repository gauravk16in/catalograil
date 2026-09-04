import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '@catalograil/core';

/**
 * S3.2 — prove the credentials work before storing them.
 *
 * A merchant who mistypes a key should find out on the settings screen, not when their
 * first buyer reaches checkout. So the flow is verify-then-store, never store-then-verify:
 * a rejected key leaves no row behind and no half-connected state to reason about.
 *
 * The probe is deliberately the most harmless authenticated call Razorpay offers —
 * fetching one payment. It reads nothing sensitive, changes nothing, and costs nothing,
 * and a 401 from it means exactly one thing.
 */

export interface VerifyResult {
  readonly ok: boolean;
  readonly mode: 'test' | 'live';
  /** Present on failure. Safe to show a merchant; never contains the secret. */
  readonly error?: string;
}

export type Fetcher = typeof fetch;

const RAZORPAY_API = 'https://api.razorpay.com/v1';

/** `rzp_test_` or `rzp_live_`, then at least ten more characters. */
const KEY_ID_PATTERN = /^rzp_(test|live)_[A-Za-z0-9]{10,}$/;

export function validateKeyFormat(keyId: string): 'test' | 'live' {
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new AppError(
      'VALIDATION_FAILED',
      'That does not look like a Razorpay key id. They start with rzp_test_ or rzp_live_.',
    );
  }
  return keyId.startsWith('rzp_live_') ? 'live' : 'test';
}

export async function verifyApiKeys(
  keyId: string,
  keySecret: string,
  fetcher: Fetcher = fetch,
): Promise<VerifyResult> {
  const mode = validateKeyFormat(keyId);
  const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');

  let response: Response;
  try {
    response = await fetcher(`${RAZORPAY_API}/payments?count=1`, {
      headers: { authorization: `Basic ${auth}` },
      // Razorpay is normally fast; a merchant waiting on a settings form is not.
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    // A network failure is not a bad credential, and saying so stops a merchant from
    // rotating a key that was fine.
    return {
      ok: false,
      mode,
      error:
        err instanceof Error && err.name === 'TimeoutError'
          ? 'Razorpay did not respond in time. Try again in a moment.'
          : 'Could not reach Razorpay to check these credentials.',
    };
  }

  if (response.status === 401) {
    return { ok: false, mode, error: 'Razorpay rejected these credentials.' };
  }
  if (!response.ok) {
    return {
      ok: false,
      mode,
      error: `Razorpay returned ${response.status} when checking these credentials.`,
    };
  }

  return { ok: true, mode };
}

/**
 * Rule 2's other half: a webhook is only trustworthy if its signature verifies against the
 * secret *this merchant* configured.
 *
 * `timingSafeEqual` rather than `===`, because a byte-by-byte comparison that returns early
 * leaks how much of a forged signature was correct, and a webhook endpoint is callable by
 * anyone who learns the URL.
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string,
): boolean {
  const expected = createHmac('sha256', secret).update(payload).digest('hex');
  const given = Buffer.from(signature, 'utf8');
  const want = Buffer.from(expected, 'utf8');
  if (given.length !== want.length) return false;
  return timingSafeEqual(given, want);
}

/**
 * S3.3's "Test webhook" button.
 *
 * Signs a sample payload with the stored secret and checks it back, so a merchant learns
 * their secret is wrong now rather than when a real payment silently fails to confirm.
 */
export function testWebhookSecret(secret: string): { ok: boolean; sample: string } {
  const sample = JSON.stringify({ event: 'catalograil.webhook.test', at: Date.now() });
  const signature = createHmac('sha256', secret).update(sample).digest('hex');
  return { ok: verifyWebhookSignature(sample, signature, secret), sample };
}
