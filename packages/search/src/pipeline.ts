import { createHash, randomUUID } from 'node:crypto';
import {
  AppError,
  DEFAULT_MIN_SEMANTIC_SIMILARITY,
  rupeesToPaise,
  type Clock,
  type QueryEmbeddingCache,
  type SearchLogger,
  type SearchRequest,
  type SearchResponse,
  type SearchResultItem,
} from '@catalograil/core';
import type { Embedder, ImageFetcher } from '@catalograil/embeddings';
import type { Sql } from 'postgres';
import { buildNoResultsReason, buildWhyThisMatched } from './explain.js';
import {
  buildTrustSignals,
  formatDeliveryEstimate,
  formatDisplayPrice,
  hydrateUnits,
} from './hydrate.js';
import { hybridSearch, type SearchFilters } from './query.js';
import { rerank } from './rerank.js';

/**
 * T1.19 — the internal search pipeline.
 *
 *   validate → query-embedding cache → embed on miss → hybrid query → business re-rank
 *   → hydrate → log
 *
 * Rule 10 governs the whole file: **no LLM call anywhere in this path**. The calling model
 * has already turned a buyer's sentence into structured parameters, and asking another
 * model to re-read them would add hundreds of milliseconds to re-derive what we were
 * handed. The only model call that can happen here is a single embedding on a cache miss.
 */

export interface SearchPipelineDeps {
  readonly sql: Sql;
  readonly embedder: Embedder;
  readonly queryCache: QueryEmbeddingCache;
  readonly searchLogger: SearchLogger;
  readonly imageFetcher?: ImageFetcher;
  readonly clock: Clock;
}

/** Candidates pulled before re-ranking. Wider than the page so re-rank has room to reorder. */
const RERANK_POOL = 30;

export async function runSearch(
  request: SearchRequest,
  deps: SearchPipelineDeps,
): Promise<SearchResponse> {
  const startedAt = performance.now();
  const searchId = randomUUID();
  const filters = request.filters;

  let embedMs = 0;
  let queryMs = 0;
  let rerankMs = 0;
  let hydrateMs = 0;
  let cacheHit = false;

  // ── Embed ────────────────────────────────────────────────────────────────────
  let queryVector: number[] | null = null;
  if (request.query) {
    const t = performance.now();
    const hash = queryHash(request.query);
    const cached = await deps.queryCache.get(hash);

    if (cached) {
      queryVector = cached;
      cacheHit = true;
    } else {
      /**
       * `search_query`, not `search_document`. Cohere embeds the two asymmetrically, and
       * using the document type for a query costs recall silently — nothing fails, results
       * are just quietly worse.
       */
      const [vector] = await deps.embedder.embedTexts([request.query], 'search_query');
      if (!vector)
        throw new AppError('QUERY_EMBEDDING_FAILED', 'No embedding returned for the query.');
      queryVector = vector;
      // Cache write is not awaited into the critical path's failure modes: a cache that
      // cannot be written should slow nothing and fail nothing.
      void deps.queryCache.set(hash, vector).catch(() => {});
    }
    embedMs = performance.now() - t;
  }

  let visualVector: number[] | null = null;
  if (request.imageUrl && deps.imageFetcher) {
    const t = performance.now();
    const image = await deps.imageFetcher.fetch(request.imageUrl);
    if (image) visualVector = await deps.embedder.embedImage(image);
    embedMs += performance.now() - t;
  }

  // ── Retrieve ─────────────────────────────────────────────────────────────────
  const categoryPath = filters.categorySlug
    ? await resolveCategoryPath(deps.sql, filters.categorySlug)
    : null;

  const queryFilters: SearchFilters = {
    ...(filters.maxPriceInr != null ? { maxPricePaise: rupeesToPaise(filters.maxPriceInr) } : {}),
    ...(filters.minPriceInr != null ? { minPricePaise: rupeesToPaise(filters.minPriceInr) } : {}),
    ...(categoryPath ? { categoryPath } : {}),
    ...(filters.maxDeliveryDays != null ? { maxDeliveryDays: filters.maxDeliveryDays } : {}),
    ...(filters.attributes ? { attributes: filters.attributes } : {}),
    ...(filters.inStockOnly != null ? { inStockOnly: filters.inStockOnly } : {}),
    ...(filters.merchantId ? { merchantId: filters.merchantId } : {}),
  };

  const queryStart = performance.now();
  const candidates = await hybridSearch(deps.sql, {
    queryVector,
    visualVector,
    queryText: request.query ?? null,
    filters: queryFilters,
    limit: RERANK_POOL,
    /**
     * Applied by default now that it has a measured value. Off would mean every nonsense
     * query returns its nearest neighbours as though they were matches; a caller that
     * genuinely wants everything can still pass 0.
     */
    minSemanticSimilarity: request.minSemanticSimilarity ?? DEFAULT_MIN_SEMANTIC_SIMILARITY,
  });
  queryMs = performance.now() - queryStart;

  // ── Empty ────────────────────────────────────────────────────────────────────
  if (candidates.length === 0) {
    /**
     * Re-runs retrieval with the buyer's filters dropped, purely to tell them something
     * true about *why* nothing matched: whether the query found nothing at all, or found
     * things their constraints then excluded. Rule 8 asks for a reason rather than an empty
     * list, and those are different reasons with different fixes.
     *
     * Only on the empty path, so it costs nothing on a normal search.
     */
    const unfiltered =
      hasAnyFilter(queryFilters) && (queryVector || request.query)
        ? await hybridSearch(deps.sql, {
            queryVector,
            visualVector,
            queryText: request.query ?? null,
            filters: {},
            limit: 1,
          }).catch(() => [])
        : [];

    const response: SearchResponse = {
      results: [],
      noResultsReason: buildNoResultsReason(filters, request.query, {
        anyBeforeFilters: unfiltered.length > 0,
      }),
      searchId,
      tookMs: Math.round(performance.now() - startedAt),
    };

    await logSearch(deps, request, searchId, response, {
      cacheHit,
      latencies: { embedMs, queryMs, rerankMs, hydrateMs, totalMs: response.tookMs },
    });
    return response;
  }

  // ── Re-rank and hydrate ──────────────────────────────────────────────────────
  const hydrateStart = performance.now();
  const hydrated = await hydrateUnits(
    deps.sql,
    candidates.map((c) => c.id),
  );
  hydrateMs = performance.now() - hydrateStart;

  const rerankStart = performance.now();
  const ranked = rerank(
    candidates
      .filter((candidate) => hydrated.has(candidate.id))
      .map((candidate) => {
        const unit = hydrated.get(candidate.id)!;
        return {
          id: candidate.id,
          fusionScore: candidate.fusionScore,
          trustScore: unit.trustScore ? Number(unit.trustScore) : null,
          isNewMerchant: unit.isNewMerchant,
          deliveryDays: unit.deliveryDays,
          updatedAt: unit.updatedAt,
          matchedChannels: candidate.matchedChannels,
        };
      }),
    { now: deps.clock.now() },
  );
  rerankMs = performance.now() - rerankStart;

  const results: SearchResultItem[] = ranked.slice(0, request.limit).map((result) => {
    const unit = hydrated.get(result.candidate.id)!;
    // Rule 7: the moment this price and stock were last known true, on every item.
    const asOf = unit.updatedAt.toISOString();

    return {
      id: unit.id,
      productId: unit.productId,
      ...(unit.variantId ? { variantId: unit.variantId } : {}),
      name: unit.name,
      ...(unit.brand ? { brand: unit.brand } : {}),
      ...(formatDisplayPrice(unit.pricePaise)
        ? { displayPrice: formatDisplayPrice(unit.pricePaise) }
        : {}),
      ...(unit.pricePaise != null ? { pricePaise: unit.pricePaise.toString() } : {}),
      priceAsOf: asOf,
      availability:
        unit.pricePaise == null ? 'unknown' : unit.inStock ? 'in_stock' : 'out_of_stock',
      availabilityAsOf: asOf,
      ...(formatDeliveryEstimate(unit.deliveryDays)
        ? { deliveryEstimate: formatDeliveryEstimate(unit.deliveryDays) }
        : {}),
      ...(unit.optionValues ? { options: unit.optionValues } : {}),
      images: unit.images,
      whyThisMatched: buildWhyThisMatched(result.candidate.matchedChannels, unit, filters),
      merchant: {
        id: unit.merchantId,
        name: unit.merchantName,
        ...(unit.merchantCity ? { city: unit.merchantCity } : {}),
        trust: buildTrustSignals(unit),
      },
    };
  });

  const response: SearchResponse = {
    results,
    searchId,
    tookMs: Math.round(performance.now() - startedAt),
  };

  await logSearch(deps, request, searchId, response, {
    cacheHit,
    latencies: { embedMs, queryMs, rerankMs, hydrateMs, totalMs: response.tookMs },
  });

  return response;
}

/**
 * T1.20. Logging never fails a search.
 *
 * The buyer already has their results by this point; losing the log entry costs us a row
 * in the training set, while throwing would cost them the answer. The trade is not close.
 */
async function logSearch(
  deps: SearchPipelineDeps,
  request: SearchRequest,
  searchId: string,
  response: SearchResponse,
  extra: { cacheHit: boolean; latencies: Parameters<SearchLogger['log']>[0]['latencies'] },
): Promise<void> {
  try {
    await deps.searchLogger.log({
      searchId,
      at: deps.clock.now(),
      ...(request.query ? { query: request.query } : {}),
      hasImage: Boolean(request.imageUrl),
      filters: request.filters as Record<string, unknown>,
      embeddingCacheHit: extra.cacheHit,
      resultIds: response.results.map((r) => r.id),
      resultCount: response.results.length,
      ...(response.noResultsReason ? { noResultsReason: response.noResultsReason } : {}),
      latencies: extra.latencies,
      source: request.source,
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
    });
  } catch {
    // Deliberately swallowed — see above.
  }
}

/** Query text is normalised before hashing so trivial variants share one cached embedding. */
export function queryHash(query: string): string {
  return createHash('sha256').update(query.trim().toLowerCase().replace(/\s+/g, ' ')).digest('hex');
}

async function resolveCategoryPath(sql: Sql, slug: string): Promise<string | null> {
  const rows = await sql<{ path: string | null }[]>`
    SELECT path::text AS path FROM categories WHERE slug = ${slug} LIMIT 1`;
  return rows[0]?.path ?? null;
}

function hasAnyFilter(filters: SearchFilters): boolean {
  return Object.values(filters).some(
    (value) => value !== undefined && value !== null && value !== false,
  );
}
