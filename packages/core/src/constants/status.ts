export const MERCHANT_STATUSES = ['pending', 'active', 'suspended', 'delisted'] as const;
export type MerchantStatus = (typeof MERCHANT_STATUSES)[number];

export const PRODUCT_STATUSES = ['draft', 'active', 'archived'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export const EMBEDDING_STATUSES = ['pending', 'indexed', 'failed'] as const;
export type EmbeddingStatus = (typeof EMBEDDING_STATUSES)[number];

export const ORDER_STATUSES = [
  'awaiting_payment',
  'paid',
  'confirmed',
  'packed',
  'shipped',
  'delivered',
  'cancelled',
  'refunded',
  'failed',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_SOURCES = ['claude', 'chatgpt', 'web'] as const;
export type OrderSource = (typeof ORDER_SOURCES)[number];

/** Per-field provenance on enriched products. `human` is never overwritten by the AI worker. */
export const ENRICHMENT_SOURCES = ['ai', 'human', 'mixed'] as const;
export type EnrichmentSource = (typeof ENRICHMENT_SOURCES)[number];
