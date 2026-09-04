/** Rule 6: never return more than 5 results from an MCP tool. */
export const MCP_MAX_RESULTS = 5;

/** Rule 12: adapter fan-out budget. */
export const ADAPTER_TIMEOUT_MS = 2_000;
export const ADAPTER_CIRCUIT_BREAKER_THRESHOLD = 3;

/** Search tuning (T1.17). */
export const HNSW_EF_SEARCH = 100;
export const SEARCH_CANDIDATE_LIMIT = 100;
export const SEARCH_FUSION_LIMIT = 30;
export const SEARCH_RRF_K = 60;

/** Reciprocal-rank-fusion channel weights (T1.17). */
export const RRF_WEIGHTS = { semantic: 1.0, intent: 0.6, lexical: 0.8 } as const;

/** Business re-rank weights (T1.18). Must sum to 1. */
export const RERANK_WEIGHTS = {
  fusion: 0.55,
  trust: 0.2,
  deliverySpeed: 0.15,
  freshness: 0.1,
} as const;

/** A merchant below this many completed orders cannot win on trust alone (never-do #3). */
export const NEW_MERCHANT_ORDER_THRESHOLD = 10;
export const NEW_MERCHANT_TRUST_MULTIPLIER = 0.6;

/** Ingestion caps (T1.11). */
export const MAX_STORED_INGESTION_ERRORS = 500;
export const ENRICHMENT_BATCH_SIZE = 20;

/** Embedding dimensions (D5). */
export const EMBEDDING_DIMENSIONS = 1024;
