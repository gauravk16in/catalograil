import { merchantPaymentConfig, merchantPolicies, merchants, type Database } from '@catalograil/db';
import { eq } from 'drizzle-orm';

/**
 * When a merchant is allowed to be visible to buyers.
 *
 * Two independent gates, and both must hold:
 *
 *   - **Policies**, because rule 4 snapshots them onto every order. A merchant with no
 *     policies on file has no contract to show a buyer who wants to return something.
 *   - **Verified payment config**, because of rule 15. A merchant in search who cannot take
 *     payment produces a buyer who chose a product, reached checkout, and could not pay —
 *     which is a worse experience than never having seen the listing.
 *
 * This exists as one function because the two gates are cleared on different screens, in
 * either order. Policies used to activate a merchant on their own, which was right when
 * Razorpay OAuth was step one and anyone reaching policies necessarily had a token. DC1 and
 * DC2 separated identity from payment, so that assumption quietly stopped holding: a
 * merchant could accept policies with no payment connection at all and have their catalogue
 * go live.
 */
export interface ActivationState {
  readonly status: string;
  readonly policiesAccepted: boolean;
  readonly paymentVerified: boolean;
  /** What is still blocking them, in words the dashboard can show verbatim. */
  readonly blockers: string[];
}

export async function reconcileMerchantStatus(
  db: Database,
  merchantId: string,
  now: Date,
): Promise<ActivationState> {
  const [current] = await db
    .select({ status: merchants.status })
    .from(merchants)
    .where(eq(merchants.id, merchantId))
    .limit(1);

  const [policies] = await db
    .select({ lastCheckStatus: merchantPolicies.lastCheckStatus })
    .from(merchantPolicies)
    .where(eq(merchantPolicies.merchantId, merchantId))
    .limit(1);

  const [payment] = await db
    .select({ status: merchantPaymentConfig.status })
    .from(merchantPaymentConfig)
    .where(eq(merchantPaymentConfig.merchantId, merchantId))
    .limit(1);

  const policiesAccepted = policies?.lastCheckStatus === 'ok';
  const paymentVerified = payment?.status === 'verified';

  const blockers: string[] = [];
  if (!policiesAccepted) blockers.push('your refund, terms and fulfillment URLs');
  if (!paymentVerified) blockers.push('a verified Razorpay connection');

  /**
   * Suspended and delisted are left alone.
   *
   * Those are administrative decisions about a merchant, not states they can clear by
   * filling in a form, and reconciling them here would let a suspended merchant restore
   * themselves by re-submitting a policy URL.
   */
  if (current && ['suspended', 'delisted'].includes(current.status)) {
    return { status: current.status, policiesAccepted, paymentVerified, blockers };
  }

  const target = blockers.length === 0 ? 'active' : 'pending';

  if (current && current.status !== target) {
    // The T1.16 trigger propagates this into `searchable_units.merchant_status`, which is
    // what every search filters on — so this write is the thing that makes a catalogue
    // appear or disappear.
    await db
      .update(merchants)
      .set({
        status: target,
        ...(target === 'active' ? { onboardedAt: now } : {}),
        updatedAt: now,
      })
      .where(eq(merchants.id, merchantId));
  }

  return { status: target, policiesAccepted, paymentVerified, blockers };
}
