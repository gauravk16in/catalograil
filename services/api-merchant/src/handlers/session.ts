import { AppError } from '@catalograil/core';
import { merchantCapabilities, merchantPolicies, merchants, type Database } from '@catalograil/db';
import { eq } from 'drizzle-orm';

/**
 * `GET /merchant/me` — who the caller is and how far through onboarding they are.
 *
 * The dashboard needs this on nearly every page: to mark its own products in search
 * results, to decide which step of the wizard to show, and to explain a blocked state. One
 * endpoint returning the whole picture beats four that each return a piece.
 */

export interface MerchantSession {
  readonly merchantId: string;
  readonly businessName: string;
  readonly contactEmail: string;
  readonly status: string;
  readonly capabilities: string[];
  /** What still stands between them and `active`, in the order they should do it. */
  readonly onboarding: {
    readonly connectedRazorpay: boolean;
    readonly declaredCapabilities: boolean;
    readonly policiesAccepted: boolean;
    readonly nextStep: 'connect' | 'capabilities' | 'policies' | 'done';
  };
}

export async function getSession(db: Database, merchantId: string): Promise<MerchantSession> {
  const rows = await db
    .select({
      id: merchants.id,
      businessName: merchants.businessName,
      contactEmail: merchants.contactEmail,
      status: merchants.status,
      razorpayAccountId: merchants.razorpayAccountId,
    })
    .from(merchants)
    .where(eq(merchants.id, merchantId))
    .limit(1);

  const merchant = rows[0];
  if (!merchant) throw new AppError('NOT_FOUND', 'No such merchant.');

  const [capabilities, policies] = await Promise.all([
    db
      .select({ capability: merchantCapabilities.capability })
      .from(merchantCapabilities)
      .where(eq(merchantCapabilities.merchantId, merchantId)),
    db
      .select({ status: merchantPolicies.lastCheckStatus })
      .from(merchantPolicies)
      .where(eq(merchantPolicies.merchantId, merchantId))
      .limit(1),
  ]);

  const connectedRazorpay = Boolean(merchant.razorpayAccountId);
  const declaredCapabilities = capabilities.length > 0;
  const policiesAccepted = policies[0]?.status === 'ok';

  return {
    merchantId: merchant.id,
    businessName: merchant.businessName,
    contactEmail: merchant.contactEmail,
    status: merchant.status,
    capabilities: capabilities.map((c) => c.capability),
    onboarding: {
      connectedRazorpay,
      declaredCapabilities,
      policiesAccepted,
      // Ordered by dependency, not preference: policies cannot be validated for a merchant
      // who has not connected, so there is only ever one meaningful next step.
      nextStep: !connectedRazorpay
        ? 'connect'
        : !declaredCapabilities
          ? 'capabilities'
          : !policiesAccepted
            ? 'policies'
            : 'done',
    },
  };
}
