import type { Sql } from 'postgres';
import { NEW_MERCHANT_ORDER_THRESHOLD, formatPaise, type TrustSignals } from '@catalograil/core';

/**
 * Turns ranked unit ids into rows a caller can display (T1.19).
 *
 * One query for the whole page rather than one per result, and explicitly no `SELECT *`
 * (never-do #1) — `searchable_units` carries three 1024-wide vectors that nothing
 * downstream wants and that would dominate the response.
 */

export interface HydratedUnit {
  readonly id: string;
  readonly productId: string;
  readonly variantId: string | null;
  readonly name: string;
  readonly brand: string | null;
  readonly images: string[];
  readonly pricePaise: bigint | null;
  readonly inStock: boolean;
  readonly deliveryDays: number | null;
  readonly attributes: Record<string, unknown>;
  readonly optionValues: Record<string, string> | null;
  readonly useCases: string[] | null;
  /** When the price and stock were last known true — feeds `price_as_of` (rule 7). */
  readonly updatedAt: Date;
  readonly merchantId: string;
  readonly merchantName: string;
  readonly merchantCity: string | null;
  readonly gstinVerified: boolean;
  readonly ordersFulfilled: number;
  readonly ordersTotal: number;
  readonly onTimeDeliveries: number;
  readonly avgRating: string | null;
  readonly ratingCount: number;
  readonly trustScore: string | null;
  readonly isNewMerchant: boolean;
}

export async function hydrateUnits(
  sql: Sql,
  ids: readonly string[],
): Promise<Map<string, HydratedUnit>> {
  if (ids.length === 0) return new Map();

  const rows = await sql<HydratedRow[]>`
    SELECT
      su.id::text                      AS id,
      su.product_id::text              AS product_id,
      su.variant_id::text              AS variant_id,
      p.name                           AS name,
      p.brand                          AS brand,
      COALESCE(pv.images, p.images, ARRAY[]::text[]) AS images,
      su.price_paise                   AS price_paise,
      su.in_stock                      AS in_stock,
      su.delivery_days                 AS delivery_days,
      su.attributes                    AS attributes,
      pv.option_values                 AS option_values,
      p.use_cases                      AS use_cases,
      su.updated_at                    AS updated_at,
      m.id::text                       AS merchant_id,
      m.business_name                  AS merchant_name,
      m.city                           AS merchant_city,
      m.gstin_verified                 AS gstin_verified,
      COALESCE(mm.orders_fulfilled, 0) AS orders_fulfilled,
      COALESCE(mm.orders_total, 0)     AS orders_total,
      COALESCE(mm.on_time_deliveries, 0) AS on_time_deliveries,
      mm.avg_rating                    AS avg_rating,
      COALESCE(mm.rating_count, 0)     AS rating_count,
      su.trust_score                   AS trust_score,
      COALESCE(mm.is_new_merchant, TRUE) AS is_new_merchant
    FROM searchable_units su
    JOIN products p        ON p.id = su.product_id
    JOIN merchants m       ON m.id = su.merchant_id
    LEFT JOIN product_variants pv ON pv.id = su.variant_id
    LEFT JOIN merchant_metrics mm ON mm.merchant_id = su.merchant_id
    WHERE su.id = ANY(${ids as string[]}::uuid[])`;

  return new Map(rows.map((row) => [row.id, mapRow(row)]));
}

interface HydratedRow {
  id: string;
  product_id: string;
  variant_id: string | null;
  name: string;
  brand: string | null;
  images: string[] | null;
  price_paise: string | bigint | null;
  in_stock: boolean;
  delivery_days: number | null;
  attributes: Record<string, unknown> | null;
  option_values: Record<string, string> | null;
  use_cases: string[] | null;
  updated_at: Date;
  merchant_id: string;
  merchant_name: string;
  merchant_city: string | null;
  gstin_verified: boolean;
  orders_fulfilled: number;
  orders_total: number;
  on_time_deliveries: number;
  avg_rating: string | null;
  rating_count: number;
  trust_score: string | null;
  is_new_merchant: boolean;
}

function mapRow(row: HydratedRow): HydratedUnit {
  return {
    id: row.id,
    productId: row.product_id,
    variantId: row.variant_id,
    name: row.name,
    brand: row.brand,
    images: row.images ?? [],
    // postgres.js hands back bigint columns as strings; re-widening here keeps money exact.
    pricePaise: row.price_paise == null ? null : BigInt(row.price_paise),
    inStock: row.in_stock,
    deliveryDays: row.delivery_days,
    attributes: row.attributes ?? {},
    optionValues: row.option_values,
    useCases: row.use_cases,
    updatedAt: row.updated_at,
    merchantId: row.merchant_id,
    merchantName: row.merchant_name,
    merchantCity: row.merchant_city,
    gstinVerified: row.gstin_verified,
    ordersFulfilled: row.orders_fulfilled,
    ordersTotal: row.orders_total,
    onTimeDeliveries: row.on_time_deliveries,
    avgRating: row.avg_rating,
    ratingCount: row.rating_count,
    trustScore: row.trust_score,
    isNewMerchant: row.is_new_merchant,
  };
}

/**
 * Renders trust as statements a buyer can weigh, not a number they cannot.
 *
 * "0.87" means nothing to someone deciding whether to hand over money; "312 orders
 * fulfilled, 94% delivered on time" is the same information in a form they can act on. The
 * score is still returned for ranking, but the signals are what a surface should show.
 *
 * A merchant below the order threshold is marked new rather than having their signals
 * hidden — never-do #3 caps what they can win on, and saying so plainly is fairer to both
 * sides than silently suppressing a genuinely good new merchant.
 */
export function buildTrustSignals(unit: HydratedUnit): TrustSignals {
  const signals: string[] = [];

  if (unit.gstinVerified) signals.push('GSTIN verified');

  if (unit.ordersFulfilled > 0) {
    signals.push(`${unit.ordersFulfilled.toLocaleString('en-IN')} orders fulfilled`);
  }

  if (unit.ordersFulfilled >= NEW_MERCHANT_ORDER_THRESHOLD && unit.onTimeDeliveries > 0) {
    const pct = Math.round((unit.onTimeDeliveries / unit.ordersFulfilled) * 100);
    signals.push(`${pct}% delivered on time`);
  }

  if (unit.avgRating && unit.ratingCount > 0) {
    signals.push(`${Number(unit.avgRating).toFixed(1)}★ from ${unit.ratingCount} buyers`);
  }

  if (unit.isNewMerchant) signals.push('New merchant');

  return {
    score: unit.trustScore ? Number(unit.trustScore) : 0,
    newMerchant: unit.isNewMerchant,
    signals,
  };
}

/** "Arrives in 3 days", or nothing when the merchant has not promised a window. */
export function formatDeliveryEstimate(
  deliveryDays: number | null,
  pincode?: string,
): string | undefined {
  if (deliveryDays == null) return undefined;
  const days = deliveryDays === 1 ? '1 day' : `${deliveryDays} days`;
  return pincode ? `Arrives in ${days} to ${pincode}` : `Arrives in ${days}`;
}

export function formatDisplayPrice(pricePaise: bigint | null): string | undefined {
  return pricePaise == null ? undefined : formatPaise(pricePaise);
}
