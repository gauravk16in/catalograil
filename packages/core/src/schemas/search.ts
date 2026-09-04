import { z } from 'zod';
import { MCP_MAX_RESULTS } from '../constants/index.js';

/**
 * The `/internal/search` contract (T1.19), shared by the handler that serves it and every
 * caller that consumes it — the MCP tools in Phase 2 and the dashboard's "Preview in AI"
 * (T1.25) both go through this same shape.
 *
 * Prices arrive and leave as paise (rule 13). `maxPriceInr` exists on the request because
 * that is the unit a buyer's question is phrased in ("under 2000 rupees"), and it is
 * converted once, here at the boundary, rather than in each caller.
 */

export const searchFiltersSchema = z
  .object({
    maxPriceInr: z.number().positive().optional(),
    minPriceInr: z.number().positive().optional(),
    /** Category slug; resolved to an ltree path by the handler. */
    categorySlug: z.string().trim().min(1).optional(),
    maxDeliveryDays: z.number().int().positive().max(90).optional(),
    /** Exact attribute match, e.g. `{ "size": "42", "fabric": "cotton" }`. */
    attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    inStockOnly: z.boolean().optional(),
    /** Restricts to one merchant — the dashboard's preview, never a buyer-facing search. */
    merchantId: z.string().uuid().optional(),
  })
  .strict();

export const searchRequestSchema = z
  .object({
    query: z.string().trim().min(1).max(500).optional(),
    /** Phase 2 image search; embedded and used as the visual channel. */
    imageUrl: z.string().url().optional(),
    filters: searchFiltersSchema.default({}),
    /** Rule 6 caps MCP responses at 5; the internal API allows more for the dashboard. */
    limit: z.number().int().positive().max(50).default(MCP_MAX_RESULTS),
    /**
     * Cosine similarity a semantic match must reach to count, 0..1.
     *
     * A vector index always has a nearest neighbour, so without a floor no text query can
     * ever return nothing and rule 8's `no_results_reason` never fires. Left unset by
     * default because the right value depends on the embedding model's distance
     * distribution and has to be measured on real catalogue data.
     */
    minSemanticSimilarity: z.number().min(0).max(1).optional(),
    /** Recorded in the search log so ranking can later be analysed by surface. */
    source: z.enum(['claude', 'chatgpt', 'web', 'dashboard', 'test']).default('web'),
    sessionId: z.string().max(200).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.query || value.imageUrl), {
    message: 'A search needs a query, an image, or both.',
  });

export type SearchRequest = z.infer<typeof searchRequestSchema>;
export type SearchFiltersInput = z.infer<typeof searchFiltersSchema>;

export interface TrustSignals {
  readonly score: number;
  readonly newMerchant: boolean;
  /** Human-readable, already rendered — "312 orders fulfilled", not a raw count. */
  readonly signals: string[];
}

export interface SearchResultMerchant {
  readonly id: string;
  readonly name: string;
  readonly city?: string;
  readonly trust: TrustSignals;
}

export interface SearchResultItem {
  readonly id: string;
  readonly productId: string;
  readonly variantId?: string;
  readonly name: string;
  readonly brand?: string;
  /** Formatted for display, e.g. "₹2,499". Never parse this back into a number. */
  readonly displayPrice?: string;
  readonly pricePaise?: string;
  /**
   * Rule 7: every price carries the time it was known to be true. A bare number invites
   * the calling model to present a stale price as current.
   */
  readonly priceAsOf: string;
  readonly availability: 'in_stock' | 'out_of_stock' | 'unknown';
  readonly availabilityAsOf: string;
  readonly deliveryEstimate?: string;
  readonly options?: Record<string, string>;
  readonly images: string[];
  /**
   * Rule 8's sibling: a templated sentence assembled from the signals that actually fired,
   * never generated text. The calling model must be able to trust it as fact.
   */
  readonly whyThisMatched: string;
  readonly merchant: SearchResultMerchant;
}

export interface SearchResponse {
  readonly results: SearchResultItem[];
  /**
   * Rule 8: an empty result set says why, so the model states a fact instead of inventing
   * a reason. Present only when `results` is empty.
   */
  readonly noResultsReason?: string;
  readonly searchId: string;
  readonly tookMs: number;
}
