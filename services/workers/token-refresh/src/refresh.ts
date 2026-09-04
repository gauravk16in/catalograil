import { AppError, type Clock, type Mailer } from '@catalograil/core';
import { merchantTokens, merchants, type Database } from '@catalograil/db';
import { refreshAccessToken, type OAuthConfig, type TokenCipher } from '@catalograil/razorpay';
import { and, eq, lt, sql } from 'drizzle-orm';

/**
 * T1.7 — the token refresh worker. Runs daily at 02:00 IST.
 *
 * Rule 15 is what makes this matter: a merchant whose token has expired is excluded from
 * search rather than allowed to fail at checkout. That is the right behaviour, and it also
 * means an expired token silently costs a merchant every sale until someone notices. This
 * worker is what stops that happening quietly.
 */

/** Refreshed well before expiry, so a failure has two weeks of daily retries to recover in. */
const REFRESH_WINDOW_DAYS = 14;

/** T1.7: suspended after three consecutive failures. */
const MAX_REFRESH_FAILURES = 3;

export interface TokenRefreshDeps {
  readonly db: Database;
  readonly oauthConfig: OAuthConfig;
  readonly cipherFor: (merchantId: string) => TokenCipher;
  readonly mailer: Mailer;
  readonly clock: Clock;
}

export interface TokenRefreshOutcome {
  readonly examined: number;
  readonly refreshed: number;
  readonly failed: number;
  readonly suspended: number;
}

export async function runTokenRefresh(deps: TokenRefreshDeps): Promise<TokenRefreshOutcome> {
  const cutoff = new Date(deps.clock.now().getTime() + REFRESH_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  // The index on access_expires_at exists for exactly this scan.
  const due = await deps.db
    .select({
      merchantId: merchantTokens.merchantId,
      refreshToken: merchantTokens.refreshToken,
      refreshFailures: merchantTokens.refreshFailures,
      contactEmail: merchants.contactEmail,
      businessName: merchants.businessName,
      status: merchants.status,
    })
    .from(merchantTokens)
    .innerJoin(merchants, eq(merchants.id, merchantTokens.merchantId))
    .where(and(lt(merchantTokens.accessExpiresAt, cutoff), eq(merchants.status, 'active')));

  const outcome = { examined: due.length, refreshed: 0, failed: 0, suspended: 0 };

  for (const row of due) {
    try {
      const cipher = deps.cipherFor(row.merchantId);
      const plaintext = await cipher.decrypt(row.refreshToken);
      const tokens = await refreshAccessToken(deps.oauthConfig, plaintext);

      const [accessToken, refreshToken] = await Promise.all([
        cipher.encrypt(tokens.accessToken),
        cipher.encrypt(tokens.refreshToken),
      ]);

      await deps.db
        .update(merchantTokens)
        .set({
          accessToken,
          refreshToken,
          accessExpiresAt: tokens.accessExpiresAt,
          refreshExpiresAt: tokens.refreshExpiresAt,
          lastRefreshedAt: deps.clock.now(),
          refreshFailures: 0,
        })
        .where(eq(merchantTokens.merchantId, row.merchantId));

      outcome.refreshed++;
    } catch (err) {
      outcome.failed++;
      const failures = row.refreshFailures + 1;

      await deps.db
        .update(merchantTokens)
        .set({ refreshFailures: sql`${merchantTokens.refreshFailures} + 1` })
        .where(eq(merchantTokens.merchantId, row.merchantId));

      if (failures >= MAX_REFRESH_FAILURES) {
        /**
         * Suspension is the honest outcome: without a working token we cannot create a
         * payment on their account, so every listing of theirs is unsellable. The T1.16
         * trigger removes their catalogue from search in the same statement.
         */
        await deps.db
          .update(merchants)
          .set({ status: 'suspended' })
          .where(eq(merchants.id, row.merchantId));
        outcome.suspended++;

        await notify(deps, row.contactEmail, {
          subject: 'Your CatalogRail listings have been paused',
          text: [
            `We could not refresh the Razorpay connection for ${row.businessName} after ${MAX_REFRESH_FAILURES} attempts.`,
            '',
            'Your products have been removed from search until the connection is restored — this is deliberate, so that no buyer is shown something that cannot actually be purchased.',
            '',
            'Reconnect Razorpay from your dashboard to bring them back. Nothing in your catalogue has been deleted.',
          ].join('\n'),
        });
      } else {
        await notify(deps, row.contactEmail, {
          subject: 'Action needed: your Razorpay connection',
          text: [
            `We could not refresh the Razorpay connection for ${row.businessName}.`,
            '',
            `This was attempt ${failures} of ${MAX_REFRESH_FAILURES}. We will try again tomorrow.`,
            'If it keeps failing your listings will be paused, so reconnecting from your dashboard now is the safest fix.',
            '',
            `Reason: ${err instanceof AppError ? err.message : 'The refresh was refused.'}`,
          ].join('\n'),
        });
      }
    }
  }

  return outcome;
}

/** A failed notification must not stop the remaining merchants being processed. */
async function notify(
  deps: TokenRefreshDeps,
  to: string,
  content: { subject: string; text: string },
): Promise<void> {
  try {
    await deps.mailer.send({ to, ...content });
  } catch {
    // Swallowed deliberately.
  }
}

export { MAX_REFRESH_FAILURES, REFRESH_WINDOW_DAYS };
