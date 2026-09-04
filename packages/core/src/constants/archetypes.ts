/**
 * The five archetypes (context §3). Every product declares exactly one.
 * This drives schema, embedding text, MCP response shape and checkout flow.
 */
export const ARCHETYPES = ['SIMPLE', 'VARIANT', 'LIVE_PRICED', 'BOOKABLE', 'QUOTE'] as const;
export type Archetype = (typeof ARCHETYPES)[number];

/** Archetypes exposed in Phase 1. The rest exist in the schema but are not sellable yet. */
export const PHASE_1_ARCHETYPES = ['SIMPLE', 'VARIANT'] as const satisfies readonly Archetype[];

export type Phase1Archetype = (typeof PHASE_1_ARCHETYPES)[number];

export function isPhase1Archetype(a: Archetype): a is Phase1Archetype {
  return (PHASE_1_ARCHETYPES as readonly Archetype[]).includes(a);
}

/** The unit a search hit resolves to. D6: the variant, not the product. */
export const UNIT_TYPES = ['variant', 'product', 'offering'] as const;
export type UnitType = (typeof UNIT_TYPES)[number];

/** Which unit type an archetype expands into in `searchable_units`. */
export const ARCHETYPE_UNIT_TYPE: Record<Archetype, UnitType> = {
  SIMPLE: 'product',
  VARIANT: 'variant',
  LIVE_PRICED: 'offering',
  BOOKABLE: 'offering',
  QUOTE: 'offering',
};

export const MERCHANT_CAPABILITIES = ['catalog', 'live_price', 'bookable', 'quote'] as const;
export type MerchantCapability = (typeof MERCHANT_CAPABILITIES)[number];

/** Only `catalog` is live in Phase 1; the others are stored and reported as phase-3. */
export const PHASE_1_CAPABILITIES = ['catalog'] as const satisfies readonly MerchantCapability[];
