/** Rule 6: never return more than 5 results from an MCP tool. */
export const MCP_MAX_RESULTS = 5;

/** Rule 12: adapter fan-out budget. */
export const ADAPTER_TIMEOUT_MS = 2_000;
export const ADAPTER_CIRCUIT_BREAKER_THRESHOLD = 3;

/** Search tuning (T1.17). */
export const HNSW_EF_SEARCH = 100;

/**
 * Ceiling on pgvector's iterative index scan, in tuples.
 *
 * Only binds when a query matches little or nothing — the scan stops early as soon as it
 * has enough qualifying rows. Without it, a query that matches nothing walks the entire
 * graph proving so, which is precisely the case a relevance floor creates.
 */
export const HNSW_MAX_SCAN_TUPLES = 20_000;
export const SEARCH_CANDIDATE_LIMIT = 100;
export const SEARCH_FUSION_LIMIT = 30;
export const SEARCH_RRF_K = 60;

/** Reciprocal-rank-fusion channel weights (T1.17). */
export const RRF_WEIGHTS = { semantic: 1.0, intent: 0.6, lexical: 0.8, visual: 1.0 } as const;

/**
 * How much the text channels are worth when an image is also given (T2.9).
 *
 * A buyer who uploads a photo *and* types has told us two things, and the photo is the more
 * specific of the two: "this, but in size 42" means the picture defines what, and the words
 * refine it. Leaving the text channels at full weight lets a strong lexical match on the
 * word "shirt" outrank items that actually look like the photo — which reads to the buyer as
 * the image having been ignored.
 */
export const TEXT_WEIGHT_WITH_IMAGE = 0.6;

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

/**
 * Cosine similarity a semantic match must reach to count as a match at all.
 *
 * A vector index always has a nearest neighbour — it answers "what is closest", and
 * something always is — so without a floor no text query can ever return nothing, rule 8's
 * `no_results_reason` never fires, and a nonsense query comes back as a page of
 * confident-looking results for the calling model to repeat as fact.
 *
 * Measured against Cohere Embed v3 on real canonical text (T1.2's account, three products
 * across three verticals, nine queries):
 *
 *   relevant match    0.375 – 0.568
 *   wrong product     0.034 – 0.139
 *   nonsense query   -0.007 – 0.166
 *
 * 0.25 sits inside that gap with roughly 0.08 of margin above the highest noise and 0.12
 * below the lowest genuine match.
 *
 * Two honest caveats. The sample is small, so this is a defensible starting value rather
 * than a tuned one — near-misses (a query for one shirt against a different shirt) will sit
 * between the bands measured here and are exactly what a larger sample would reveal. And it
 * is specific to this embedding model: changing the model invalidates the number, which is
 * why it lives beside the model configuration rather than in the query. T1.20's search logs
 * are what should replace this measurement with a real distribution.
 */
export const DEFAULT_MIN_SEMANTIC_SIMILARITY = 0.25;

/**
 * How many extra fusion rows to fetch when a relevance floor is active.
 *
 * The floor runs in the application, after the query's LIMIT, so without over-fetching it
 * can only shrink a page rather than reach past it. Four was chosen against the measured
 * failure — a top-30 wholly deleted by the floor while real matches sat just below — and
 * costs nothing on the query side, since the rows come from the same already-sorted fusion.
 */
export const FLOOR_OVERFETCH = 4;
