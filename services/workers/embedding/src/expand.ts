import type { Archetype, UnitType } from '@catalograil/core';
import { ARCHETYPE_UNIT_TYPE } from '@catalograil/core';
import { composeCanonical, type CanonicalUnitInput } from '@catalograil/embeddings';

/**
 * Expands a product into the units that actually get searched (T1.15 step 1).
 *
 * D6 makes the variant the searchable unit, so a VARIANT product with a 4×3 matrix becomes
 * twelve rows and a SIMPLE product becomes one. This is where the fan-out happens, and
 * where each unit gets the canonical text and content hash that decide whether it needs
 * re-embedding at all.
 */

export interface ProductForExpansion {
  readonly id: string;
  readonly merchantId: string;
  readonly archetype: Archetype;
  readonly name: string;
  readonly brand?: string | null;
  readonly description?: string | null;
  readonly categoryId?: string | null;
  readonly categoryPath?: string | null;
  readonly attributes?: Record<string, unknown> | null;
  readonly useCases?: string[] | null;
  readonly targetAudience?: string[] | null;
  readonly occasions?: string[] | null;
  readonly images?: string[] | null;
  readonly routeOrScope?: string | null;
  readonly priceRangeHint?: string | null;
  readonly optionAxes: readonly { name: string; values: string[] }[];
  readonly variants: readonly VariantForExpansion[];
  readonly merchantStatus: string;
  readonly trustScore?: string | null;
}

export interface VariantForExpansion {
  readonly id: string;
  readonly sku: string;
  readonly optionValues: Record<string, string> | null;
  readonly pricePaise: bigint | null;
  readonly stock: number;
  readonly deliveryDays: number | null;
  readonly images: string[] | null;
  readonly status: string;
}

export interface ExpandedUnit {
  readonly unitType: UnitType;
  readonly productId: string;
  readonly variantId: string | null;
  readonly merchantId: string;
  readonly archetype: Archetype;
  readonly canonicalText: string;
  readonly contentHash: string;
  /** Text for `v_intent` — use cases and audience only, never the full description. */
  readonly intentText: string;
  readonly primaryImageUrl: string | null;

  // Denormalised filterables. Kept current even when the hash has not changed.
  readonly categoryId: string | null;
  readonly categoryPath: string | null;
  readonly pricePaise: bigint | null;
  readonly inStock: boolean;
  readonly deliveryDays: number | null;
  readonly attributes: Record<string, unknown>;
  readonly merchantStatus: string;
  readonly trustScore: string | null;
}

export function expandProduct(product: ProductForExpansion): ExpandedUnit[] {
  const unitType = ARCHETYPE_UNIT_TYPE[product.archetype];

  if (unitType === 'variant') {
    return product.variants
      .filter((v) => v.status === 'active')
      .map((variant) => buildUnit(product, variant, 'variant'));
  }

  /**
   * SIMPLE products still carry exactly one variant row (ingestion creates it), so price
   * and stock live in one place for every archetype. The unit is the product, but its
   * filterables come from that single variant.
   */
  const only = product.variants.find((v) => v.status === 'active');
  return [buildUnit(product, only, unitType)];
}

function buildUnit(
  product: ProductForExpansion,
  variant: VariantForExpansion | undefined,
  unitType: UnitType,
): ExpandedUnit {
  const canonicalInput: CanonicalUnitInput = {
    archetype: product.archetype,
    name: product.name,
    brand: product.brand ?? null,
    categoryPath: product.categoryPath ?? null,
    description: product.description ?? null,
    attributes: product.attributes ?? null,
    optionValues: variant?.optionValues ?? null,
    useCases: product.useCases ?? null,
    targetAudience: product.targetAudience ?? null,
    occasions: product.occasions ?? null,
    optionAxes: product.optionAxes,
    routeOrScope: product.routeOrScope ?? null,
    priceRangeHint: product.priceRangeHint ?? null,
    deliveryDays: variant?.deliveryDays ?? null,
  };

  const { canonicalText, contentHash } = composeCanonical(canonicalInput);

  return {
    unitType,
    productId: product.id,
    variantId: unitType === 'variant' ? (variant?.id ?? null) : null,
    merchantId: product.merchantId,
    archetype: product.archetype,
    canonicalText,
    contentHash,
    intentText: composeIntentText(product),
    primaryImageUrl: primaryImage(product, variant),

    categoryId: product.categoryId ?? null,
    categoryPath: product.categoryPath ?? null,
    pricePaise: variant?.pricePaise ?? null,
    inStock: (variant?.stock ?? 0) > 0,
    deliveryDays: variant?.deliveryDays ?? null,
    attributes: mergedAttributes(product, variant),
    merchantStatus: product.merchantStatus,
    trustScore: product.trustScore ?? null,
  };
}

/**
 * The `v_intent` channel: what the thing is *for*, with none of the product description.
 *
 * Keeping the description out is the whole point. It lets "something to wear to a beach
 * wedding" match on purpose rather than on vocabulary, which is a different question from
 * the one `v_semantic` answers and is why the two vectors are separate columns.
 *
 * Empty when a product has not been enriched yet — an un-enriched product simply has no
 * intent signal, and inventing one from its name would make the channel noise.
 */
export function composeIntentText(product: ProductForExpansion): string {
  const parts = [
    labelled('Used for', product.useCases),
    labelled('Suited to', product.targetAudience),
    labelled('Occasions', product.occasions),
  ].filter(Boolean);
  return parts.join('\n');
}

function labelled(label: string, values?: string[] | null): string {
  if (!values || values.length === 0) return '';
  const cleaned = values.map((v) => v.trim()).filter(Boolean);
  return cleaned.length > 0 ? `${label}: ${cleaned.join(', ')}` : '';
}

/** The variant's own photo when it has one, otherwise the product's first. */
function primaryImage(
  product: ProductForExpansion,
  variant: VariantForExpansion | undefined,
): string | null {
  return variant?.images?.[0] ?? product.images?.[0] ?? null;
}

/** Filterable attributes include the variant's option values, matching canonical text. */
function mergedAttributes(
  product: ProductForExpansion,
  variant: VariantForExpansion | undefined,
): Record<string, unknown> {
  return { ...(product.attributes ?? {}), ...(variant?.optionValues ?? {}) };
}
