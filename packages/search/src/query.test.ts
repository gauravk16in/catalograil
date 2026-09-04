import { EMBEDDING_DIMENSIONS } from '@catalograil/core';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hybridSearch, toVectorLiteral } from './query.js';

/**
 * Runs against a real Postgres with pgvector, because every interesting property of this
 * query is a property of the planner: whether predicates reach the index, which scan gets
 * chosen, whether a dead channel forces a sequential scan. None of that is observable
 * against a fake.
 *
 * Skipped when DATABASE_URL is unset.
 */
const DATABASE_URL = process.env.DATABASE_URL;

const randomVector = (): number[] =>
  Array.from({ length: EMBEDDING_DIMENSIONS }, () => Math.random());

describe.skipIf(!DATABASE_URL)('hybrid search', () => {
  let sql: postgres.Sql;

  beforeAll(() => {
    sql = postgres(DATABASE_URL!, { max: 4, onnotice: () => {} });
  });

  afterAll(async () => {
    await sql?.end();
  });

  describe('channels', () => {
    it('runs all three channels when given both a vector and text', async () => {
      const results = await hybridSearch(sql, {
        queryVector: randomVector(),
        queryText: 'cotton shirt',
        limit: 20,
      });

      expect(results.length).toBeGreaterThan(0);
      const channels = new Set(results.flatMap((r) => r.matchedChannels));
      expect(channels.has('semantic')).toBe(true);
      expect(channels.has('intent')).toBe(true);
      expect(channels.has('lexical')).toBe(true);
    });

    it('runs lexical alone when there is no vector', async () => {
      const results = await hybridSearch(sql, { queryText: 'dashcam', limit: 10 });
      const channels = new Set(results.flatMap((r) => r.matchedChannels));
      expect(channels).toEqual(new Set(['lexical']));
    });

    it('refuses a search with no query at all', async () => {
      await expect(hybridSearch(sql, {})).rejects.toThrow(/needs a query/);
    });

    it('returns candidates in descending fusion order', async () => {
      const results = await hybridSearch(sql, { queryVector: randomVector(), limit: 20 });
      const scores = results.map((r) => r.fusionScore);
      expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    });
  });

  /**
   * Rule 5: a buyer constraint is an exclusion, not a penalty. These assert the stronger
   * property — not that constrained items rank lower, but that they are absent.
   */
  describe('filters exclude rather than penalise', () => {
    it('never returns a unit above the price ceiling', async () => {
      const maxPricePaise = 200_000n;
      const results = await hybridSearch(sql, {
        queryVector: randomVector(),
        filters: { maxPricePaise },
        limit: 50,
      });
      expect(results.length).toBeGreaterThan(0);

      const rows = await sql`
        SELECT price_paise FROM searchable_units
        WHERE id = ANY(${results.map((r) => r.id)}::uuid[])`;
      expect(rows.every((r) => r.price_paise <= maxPricePaise)).toBe(true);
    });

    it('never returns an out-of-stock unit when in-stock is required', async () => {
      const results = await hybridSearch(sql, {
        queryVector: randomVector(),
        filters: { inStockOnly: true },
        limit: 50,
      });

      const rows = await sql`
        SELECT in_stock FROM searchable_units
        WHERE id = ANY(${results.map((r) => r.id)}::uuid[])`;
      expect(rows.every((r) => r.in_stock === true)).toBe(true);
    });

    it('never returns a unit slower than the delivery constraint', async () => {
      const results = await hybridSearch(sql, {
        queryVector: randomVector(),
        filters: { maxDeliveryDays: 3 },
        limit: 50,
      });

      const rows = await sql`
        SELECT delivery_days FROM searchable_units
        WHERE id = ANY(${results.map((r) => r.id)}::uuid[])`;
      expect(rows.every((r) => r.delivery_days !== null && r.delivery_days <= 3)).toBe(true);
    });

    it('confines results to one merchant when asked', async () => {
      const [merchant] = await sql`
        SELECT merchant_id FROM searchable_units WHERE merchant_status = 'active' LIMIT 1`;
      const merchantId = merchant!.merchant_id as string;

      const results = await hybridSearch(sql, {
        queryVector: randomVector(),
        filters: { merchantId },
        limit: 30,
      });

      const rows = await sql`
        SELECT DISTINCT merchant_id FROM searchable_units
        WHERE id = ANY(${results.map((r) => r.id)}::uuid[])`;
      expect(rows.map((r) => r.merchant_id)).toEqual([merchantId]);
    });
  });

  /**
   * The planner behaviour this query was rewritten around. Each of these was a real
   * regression measured at 50k units, and each is cheap to reintroduce by "tidying" the
   * SQL, so they are pinned rather than left to a comment.
   */
  describe('planner behaviour', () => {
    async function explain(params: Parameters<typeof hybridSearch>[1]): Promise<string> {
      // Re-runs the search first so any lazy planning is warm, then inspects the plan the
      // same settings produce.
      await hybridSearch(sql, params);
      return sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL hnsw.ef_search = 100`);
        await tx.unsafe(`SET LOCAL hnsw.iterative_scan = relaxed_order`);
        await tx.unsafe(`SET LOCAL enable_seqscan = off`);
        const vector = toVectorLiteral(params.queryVector!);
        const price = params.filters?.maxPricePaise;
        const rows = await tx.unsafe(
          `EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF)
           SELECT id, RANK() OVER (ORDER BY v_semantic <=> $1::vector) AS r
           FROM searchable_units
           WHERE merchant_status = 'active' AND embedding_status = 'indexed'
             ${price != null ? 'AND price_paise <= $2::bigint' : ''}
             AND v_semantic IS NOT NULL
           ORDER BY v_semantic <=> $1::vector LIMIT 100`,
          (price != null ? [vector, price.toString()] : [vector]) as never[],
        );
        return rows.map((r) => String((r as Record<string, unknown>)['QUERY PLAN'])).join('\n');
      });
    }

    it('answers an unfiltered vector search from the HNSW index', async () => {
      const plan = await explain({ queryVector: randomVector() });
      expect(plan).toContain('searchable_units_semantic_hnsw');
      expect(plan).not.toContain('Seq Scan');
    });

    it('still uses the HNSW index when a price filter is applied', async () => {
      // The case that regressed: a filter matching most rows made the planner prefer a
      // sequential scan with a top-N sort, at 266ms against 3ms for the index.
      const plan = await explain({
        queryVector: randomVector(),
        filters: { maxPricePaise: 300_000n },
      });
      expect(plan).toContain('searchable_units_semantic_hnsw');
      expect(plan).not.toContain('Seq Scan');
    });

    it('does not pay for a channel it was given no input for', async () => {
      // A dead visual channel used to sort the whole table to produce nothing, taking a
      // keyword-only search from tens of milliseconds to 1.7 seconds. Timing is a blunt
      // assertion, but the failure mode is an order of magnitude, not a few percent.
      const started = performance.now();
      await hybridSearch(sql, { queryText: 'cotton shirt', limit: 20 });
      expect(performance.now() - started).toBeLessThan(500);
    });
  });

  describe('vector validation', () => {
    it('rejects a wrong-width vector before it reaches the planner', () => {
      expect(() => toVectorLiteral([1, 2, 3])).toThrow(/1024-dimension/);
    });

    it('formats a vector as a pgvector literal', () => {
      expect(toVectorLiteral(Array(EMBEDDING_DIMENSIONS).fill(0.5))).toMatch(/^\[0\.5,0\.5/);
    });
  });
});
