import { AppError, toDate } from '@catalograil/core';
import {
  merchantMetrics,
  merchantPolicies,
  merchants,
  productVariants,
  products,
  searchableUnits,
  type Database,
} from '@catalograil/db';
import { buildTrustSignals, computeTrust } from '@catalograil/trust';
import { eq, sql } from 'drizzle-orm';

/**
 * Detail endpoints for the MCP tools (T2.3, T2.5).
 *
 * They live beside search rather than in the merchant API because their caller is a model,
 * not a merchant: the scoping rule here is "anything a buyer may see", not "anything you
 * own". Everything returned is already reachable by anyone who can search.
 */

const PLATFORM_MEAN_RATING = 4.2;

export async function getProductDetail(
  db: Database,
  productId: string,
): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({
      id: products.id,
      name: products.name,
      brand: products.brand,
      description: products.description,
      archetype: products.archetype,
      attributes: products.attributes,
      useCases: products.useCases,
      images: products.images,
      status: products.status,
      merchantId: merchants.id,
      merchantName: merchants.businessName,
      merchantCity: merchants.city,
      merchantStatus: merchants.status,
      gstinVerified: merchants.gstinVerified,
      onboardedAt: merchants.onboardedAt,
    })
    .from(products)
    .innerJoin(merchants, eq(merchants.id, products.merchantId))
    .where(eq(products.id, productId))
    .limit(1);

  if (!row) throw new AppError('NOT_FOUND', 'No such product.');

  /**
   * A suspended merchant's product is *not found*, not forbidden.
   *
   * Test-matrix row 9 requires it never surfaces, and "forbidden" would confirm the id
   * exists — which is itself information about a merchant we have delisted.
   */
  if (row.merchantStatus !== 'active' || row.status === 'archived') {
    throw new AppError('NOT_FOUND', 'No such product.');
  }

  const variants = await db
    .select({
      id: productVariants.id,
      sku: productVariants.sku,
      optionValues: productVariants.optionValues,
      pricePaise: productVariants.pricePaise,
      mrpPaise: productVariants.mrpPaise,
      stock: productVariants.stock,
      deliveryDays: productVariants.deliveryDays,
      images: productVariants.images,
      status: productVariants.status,
    })
    .from(productVariants)
    .where(eq(productVariants.productId, productId));

  const [indexed] = await db
    .select({ updatedAt: sql<Date>`MAX(${searchableUnits.updatedAt})` })
    .from(searchableUnits)
    .where(eq(searchableUnits.productId, productId));

  // `sql<Date>` is a type assertion, not a conversion: this aggregate arrives as a string.
  const asOf = toDate(indexed?.updatedAt).toISOString();
  const trust = await merchantTrust(db, row.merchantId, row.gstinVerified, row.onboardedAt);
  const policies = await getPolicySummaries(db, row.merchantId).catch(() => null);

  return {
    id: row.id,
    name: row.name,
    brand: row.brand,
    description: row.description,
    archetype: row.archetype,
    attributes: row.attributes ?? {},
    use_cases: row.useCases ?? [],
    images: row.images ?? [],
    // Rule 7: every price carries the moment it was true, at the detail level too.
    price_as_of: asOf,
    availability_as_of: asOf,
    variants: variants
      // An inactive variant is not an option a buyer can take, and offering it invites the
      // model to describe a size that cannot be bought.
      .filter((v) => v.status === 'active')
      .map((v) => ({
        id: v.id,
        sku: v.sku,
        options: v.optionValues ?? {},
        // JSON has no bigint, and rounding paise through a double is the bug rule 13 exists
        // to prevent.
        price_paise: v.pricePaise?.toString() ?? null,
        mrp_paise: v.mrpPaise?.toString() ?? null,
        availability: (v.stock ?? 0) > 0 ? 'in_stock' : 'out_of_stock',
        stock: v.stock,
        delivery_days: v.deliveryDays,
        images: v.images ?? [],
      })),
    merchant: {
      id: row.merchantId,
      name: row.merchantName,
      city: row.merchantCity,
      trust,
    },
    policies,
  };
}

/**
 * T2.5 — only what the policy checker extracted, never generated text.
 *
 * A model asked "what's their return policy?" will happily produce a plausible one. The
 * defence is that this returns summaries and a source URL and nothing else, so there is a
 * citable fact available to state instead of an invented one.
 */
export async function getPolicySummaries(
  db: Database,
  merchantId: string,
): Promise<Record<string, unknown>> {
  const [row] = await db
    .select()
    .from(merchantPolicies)
    .where(eq(merchantPolicies.merchantId, merchantId))
    .limit(1);

  if (!row) throw new AppError('NOT_FOUND', 'This merchant has no policies on file.');

  return {
    merchant_id: merchantId,
    refund: { summary: row.refundSummary, url: row.refundUrl },
    terms: { summary: row.termsSummary, url: row.termsUrl },
    fulfillment: { summary: row.fulfillmentSummary, url: row.fulfillmentUrl },
    return_window_days: row.returnWindowDays,
    return_shipping_by: row.returnShippingBy,
    dispatch_sla_hours: row.dispatchSlaHours,
    // A summary nobody has checked in a month is worth less than one checked yesterday, and
    // the model should be able to say which it has.
    last_checked_at: row.lastCheckedAt?.toISOString() ?? null,
    last_check_status: row.lastCheckStatus,
  };
}

async function merchantTrust(
  db: Database,
  merchantId: string,
  gstinVerified: boolean,
  onboardedAt: Date | null,
): Promise<{ score: number; new_merchant: boolean; signals: string[] }> {
  const [metrics] = await db
    .select()
    .from(merchantMetrics)
    .where(eq(merchantMetrics.merchantId, merchantId))
    .limit(1);

  const businessAgeMonths = onboardedAt
    ? Math.floor((Date.now() - onboardedAt.getTime()) / (30 * 24 * 3_600_000))
    : 0;

  const inputs = {
    gstinVerified,
    // Reaching this point means the merchant is active, which under the two-gate activation
    // rule already implies verified payment and valid policies.
    razorpayAccountActive: true,
    policiesValid: true,
    businessAgeMonths,
    ordersTotal: metrics?.ordersTotal ?? 0,
    ordersFulfilled: metrics?.ordersFulfilled ?? 0,
    ordersCancelled: metrics?.ordersCancelled ?? 0,
    onTimeDeliveries: metrics?.onTimeDeliveries ?? 0,
    avgRating: metrics?.avgRating != null ? Number(metrics.avgRating) : null,
    ratingCount: metrics?.ratingCount ?? 0,
    avgAckMinutes: metrics?.avgAckMinutes ?? null,
    disputeCount: metrics?.disputeCount ?? 0,
    platformMeanRating: PLATFORM_MEAN_RATING,
  };

  const trust = computeTrust(inputs);
  return {
    score: trust.trustScore,
    new_merchant: trust.isNewMerchant,
    signals: buildTrustSignals({ ...inputs, trust }),
  };
}
