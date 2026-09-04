import {
  EMBEDDING_DIMENSIONS,
  HNSW_EF_SEARCH,
  RRF_WEIGHTS,
  SEARCH_CANDIDATE_LIMIT,
  SEARCH_FUSION_LIMIT,
  SEARCH_RRF_K,
  AppError,
} from '@catalograil/core';
import type { Sql } from 'postgres';

/**
 * T1.17 — the hybrid retrieval query.
 *
 * Three channels over one denormalised table, fused by reciprocal rank rather than by
 * comparing scores that are not on the same scale:
 *
 *   semantic  the canonical text embedding — what the thing is
 *   intent    the use-case embedding — what it is for
 *   lexical   tsvector — the exact words, which embeddings routinely miss on model
 *             numbers, SKUs and brand names
 *
 * Plus a visual channel once image search arrives (T2.9).
 *
 * Two rules shape the whole statement. Rule 5: every buyer constraint is a WHERE exclusion
 * in `filtered`, never a score penalty, so an item that cannot arrive in time cannot be
 * resurrected by being cheap. And never-do #1: nothing here selects a vector column, only
 * ids and the fusion score — the three 1024-wide vectors are ~12KB per row and the caller
 * needs none of them.
 *
 * The statement is composed rather than fixed, and that is a performance decision rather
 * than a stylistic one — see `buildChannels`.
 */

export interface SearchFilters {
  /** Hard ceiling. Null means unconstrained, not zero. */
  readonly maxPricePaise?: bigint | null;
  readonly minPricePaise?: bigint | null;
  /** ltree path; matches the subtree, so `apparel` includes `apparel.shirts`. */
  readonly categoryPath?: string | null;
  readonly maxDeliveryDays?: number | null;
  /** JSONB containment, e.g. `{ "size": "42" }`. */
  readonly attributes?: Record<string, unknown> | null;
  readonly inStockOnly?: boolean;
  /** Restricts to one merchant — used by the dashboard's "Preview in AI" (T1.25). */
  readonly merchantId?: string | null;
}

export interface HybridSearchParams {
  /** Drives the semantic and intent channels. Null for a pure image or keyword search. */
  readonly queryVector?: readonly number[] | null;
  /** Drives the visual channel (Phase 2 image search). */
  readonly visualVector?: readonly number[] | null;
  /** Drives the lexical channel. Raw buyer text; parsed by `websearch_to_tsquery`. */
  readonly queryText?: string | null;
  readonly filters?: SearchFilters;
  /** Candidates returned for re-ranking, not results shown. */
  readonly limit?: number;
}

export interface FusionCandidate {
  readonly id: string;
  readonly fusionScore: number;
  /** Which channels found this unit at all. Feeds "why this matched" (T1.19). */
  readonly matchedChannels: string[];
}

/** pgvector's literal form. Rejects a wrong-width vector here rather than in the planner. */
export function toVectorLiteral(vector: readonly number[]): string {
  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw new AppError(
      'SEARCH_FAILED',
      `Expected a ${EMBEDDING_DIMENSIONS}-dimension vector, got ${vector.length}.`,
      { details: { expected: EMBEDDING_DIMENSIONS, received: vector.length } },
    );
  }
  return `[${vector.join(',')}]`;
}

/**
 * Accumulates bind parameters so the composed SQL stays parameterised.
 *
 * The statement text is assembled at runtime, so nothing that came from a caller may reach
 * it as text — every value goes through here and appears in the SQL only as `$n`.
 */
class Binder {
  readonly values: unknown[] = [];

  bind(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

interface Channel {
  readonly name: string;
  readonly weight: number;
  readonly sql: string;
}

/**
 * Builds only the channels that actually have an input.
 *
 * Emitting all of them unconditionally and letting a NULL parameter switch one off looks
 * tidier and is a trap. `v_visual <=> NULL` is NULL for every row, so the HNSW index cannot
 * answer the ORDER BY and Postgres sorts the whole table to produce nothing. Measured at
 * 50k units that single dead channel took the query from tens of milliseconds to 1.7
 * seconds — a keyword-only search was paying for a full scan of a vector column it never
 * used.
 */
function buildChannels(
  binder: Binder,
  predicates: string,
  input: { queryLiteral: string | null; visualLiteral: string | null; queryText: string | null },
): Channel[] {
  const channels: Channel[] = [];

  const vectorChannel = (name: string, column: string, literal: string, weight: number): void => {
    // Bound once and referenced twice, so ~20KB of vector text crosses the wire a single
    // time rather than once per mention.
    const p = binder.bind(literal);
    channels.push({
      name,
      weight,
      sql: `
        SELECT id, RANK() OVER (ORDER BY ${column} <=> ${p}::vector) AS r
        FROM searchable_units
        WHERE ${predicates}
          AND ${column} IS NOT NULL
        ORDER BY ${column} <=> ${p}::vector
        LIMIT ${SEARCH_CANDIDATE_LIMIT}`,
    });
  };

  if (input.queryLiteral) {
    vectorChannel('semantic', 'v_semantic', input.queryLiteral, RRF_WEIGHTS.semantic);
    vectorChannel('intent', 'v_intent', input.queryLiteral, RRF_WEIGHTS.intent);
  }

  if (input.visualLiteral) {
    vectorChannel('visual', 'v_visual', input.visualLiteral, RRF_WEIGHTS.semantic);
  }

  if (input.queryText) {
    const p = binder.bind(input.queryText);
    channels.push({
      name: 'lexical',
      weight: RRF_WEIGHTS.lexical,
      sql: `
        SELECT id,
               RANK() OVER (ORDER BY ts_rank_cd(tsv, websearch_to_tsquery('english', ${p})) DESC) AS r
        FROM searchable_units
        WHERE ${predicates}
          AND tsv @@ websearch_to_tsquery('english', ${p})
        LIMIT ${SEARCH_CANDIDATE_LIMIT}`,
    });
  }

  return channels;
}

/**
 * Runs the fused query and returns candidate ids in fusion order.
 *
 * Scoring stops here. Trust, delivery speed and freshness are applied by the business
 * re-rank (T1.18) on the rows this returns, which is why nothing about a merchant's
 * standing appears in this file.
 */
export async function hybridSearch(
  sql: Sql,
  params: HybridSearchParams,
): Promise<FusionCandidate[]> {
  const filters = params.filters ?? {};
  const limit = params.limit ?? SEARCH_FUSION_LIMIT;

  const queryLiteral = params.queryVector?.length ? toVectorLiteral(params.queryVector) : null;
  const visualLiteral = params.visualVector?.length ? toVectorLiteral(params.visualVector) : null;
  const queryText = params.queryText?.trim() ? params.queryText.trim() : null;

  if (!queryLiteral && !visualLiteral && !queryText) {
    throw new AppError('VALIDATION_FAILED', 'A search needs a query, an image, or both.');
  }

  const binder = new Binder();

  /**
   * Only the predicates that actually apply.
   *
   * The tempting shape is `$1 IS NULL OR price_paise <= $1`, one fixed statement handling
   * every combination of filters. It defeats the planner: with applicability unknown until
   * bind time it cannot estimate selectivity, so it abandoned the HNSW index and chose a
   * sequential scan with a top-N heapsort — 30k rows scanned, 303ms, for a query the index
   * answers in single-digit milliseconds. Emitting only the live predicates gives the
   * planner something it can reason about.
   *
   * Money crosses as text, not as a JS number: postgres.js will not bind a bigint, and
   * converting paise to a Number is exactly the float rule 13 exists to prevent. The
   * `::bigint` cast turns it back into an integer inside Postgres.
   */
  const predicates: string[] = [`merchant_status = 'active'`, `embedding_status = 'indexed'`];

  if (filters.inStockOnly) predicates.push('in_stock = TRUE');
  if (filters.maxPricePaise != null) {
    predicates.push(`price_paise <= ${binder.bind(filters.maxPricePaise.toString())}::bigint`);
  }
  if (filters.minPricePaise != null) {
    predicates.push(`price_paise >= ${binder.bind(filters.minPricePaise.toString())}::bigint`);
  }
  if (filters.categoryPath) {
    predicates.push(`category_path <@ ${binder.bind(filters.categoryPath)}::ltree`);
  }
  if (filters.maxDeliveryDays != null) {
    predicates.push(`delivery_days <= ${binder.bind(filters.maxDeliveryDays)}::int`);
  }
  if (filters.attributes && Object.keys(filters.attributes).length > 0) {
    predicates.push(`attributes @> ${binder.bind(JSON.stringify(filters.attributes))}::jsonb`);
  }
  if (filters.merchantId) {
    predicates.push(`merchant_id = ${binder.bind(filters.merchantId)}::uuid`);
  }

  const predicateSql = predicates.join('\n          AND ');

  const channels = buildChannels(binder, predicateSql, { queryLiteral, visualLiteral, queryText });

  const channelCtes = channels
    .map((channel, i) => `channel_${i} AS (${channel.sql}\n      )`)
    .join(',\n      ');

  const channelUnion = channels
    .map(
      (channel, i) =>
        `SELECT id, ${binder.bind(channel.name)} AS channel, ` +
        `${binder.bind(channel.weight)}::float AS w, r FROM channel_${i}`,
    )
    .join('\n        UNION ALL\n        ');

  /**
   * No shared `filtered` CTE.
   *
   * T1.17 sketches one, and referencing it from more than one channel makes Postgres
   * materialise it — all 50k matching ids built and hash-joined per channel, 758ms.
   * `NOT MATERIALIZED` fixed that but left the predicates one join away from the index
   * scan; inlining them into each channel instead is what actually lets the planner push
   * them down into the HNSW scan as a cheap filter.
   */
  const text = `
    WITH ${channelCtes},
      fused AS (
        ${channelUnion}
      )
    SELECT
      id::text AS id,
      SUM(w / (${SEARCH_RRF_K}::float + r)) AS fusion,
      ARRAY_AGG(DISTINCT channel) AS channels
    FROM fused
    GROUP BY id
    ORDER BY fusion DESC
    LIMIT ${binder.bind(limit)}`;

  const rows = await sql.begin(async (tx) => {
    /**
     * Raised per transaction, not globally.
     *
     * HNSW trades recall for speed through `ef_search`: the default of 40 assumes an
     * unfiltered scan, and this query filters hard, so the neighbours the index returns
     * are thinned further by the WHERE clause. A higher value costs latency to buy back
     * the recall that filtering removes.
     */
    await tx.unsafe(`SET LOCAL hnsw.ef_search = ${HNSW_EF_SEARCH}`);

    /**
     * pgvector 0.8's iterative scan. Without it a filtered vector query can come back
     * short — the index finds its `ef_search` neighbours, the WHERE clause deletes most of
     * them, and the result is thin through no fault of the data.
     */
    await tx.unsafe(`SET LOCAL hnsw.iterative_scan = relaxed_order`);

    /**
     * Forces the vector indexes to be used, scoped to this transaction only.
     *
     * The planner costs an HNSW scan against a sequential scan plus a top-N sort, and with
     * a moderately selective filter it picks the sequential scan — measured at 50k units, a
     * simple price ceiling matching 60% of rows produced a Seq Scan over 30k rows at 266ms
     * for a query the index answers in under 5ms. Its cost model does not know that an
     * approximate index returns after examining a small fraction of the graph, so it
     * over-estimates the index and under-estimates the scan.
     *
     * The blunt part is real and worth stating: on a table small enough that a scan
     * genuinely is cheaper, this makes the query slower. That trade is fine here because
     * this statement only ever runs against `searchable_units`, which is large by
     * construction and gets larger, and because T1.17's acceptance criterion is explicitly
     * that the HNSW indexes are used rather than sequential scans. SET LOCAL confines it
     * to this transaction, so nothing else in the connection is affected.
     */
    await tx.unsafe(`SET LOCAL enable_seqscan = off`);

    return tx.unsafe(text, binder.values as never[]);
  });

  return (rows as unknown as { id: string; fusion: string; channels: string[] }[]).map((row) => ({
    id: row.id,
    // postgres.js returns numeric aggregates as strings to avoid precision loss.
    fusionScore: Number(row.fusion),
    matchedChannels: row.channels,
  }));
}
