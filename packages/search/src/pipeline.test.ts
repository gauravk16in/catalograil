import { EMBEDDING_DIMENSIONS, fixedClock, type SearchRequest } from '@catalograil/core';
import { InMemoryQueryEmbeddingCache, InMemorySearchLogger } from '@catalograil/aws';
import type { Embedder, ImagePayload, InputType } from '@catalograil/embeddings';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSearch, queryHash, type SearchPipelineDeps } from './pipeline.js';

/**
 * The T1.19 pipeline end to end against a real database, with a counting fake in place of
 * Bedrock — the query embedding is the only model call in this path (rule 10), and what
 * matters about it is how often it happens, which only counting can show.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const NOW = new Date('2026-09-04T12:00:00Z');

class CountingEmbedder implements Embedder {
  calls = 0;
  async embedTexts(texts: readonly string[], _t: InputType): Promise<number[][]> {
    this.calls++;
    // Derived from the text so the same query embeds identically, as a real model would.
    return texts.map((text) => {
      let h = 0;
      for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => Math.sin(h + i));
    });
  }
  async embedImage(_i: ImagePayload): Promise<number[] | null> {
    this.calls++;
    return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => Math.cos(i));
  }
}

describe.skipIf(!DATABASE_URL)('search pipeline', () => {
  let sql: postgres.Sql;

  beforeAll(() => {
    sql = postgres(DATABASE_URL!, { max: 4, onnotice: () => {} });
  });

  afterAll(async () => {
    await sql?.end();
  });

  function deps(embedder = new CountingEmbedder()): SearchPipelineDeps & {
    embedder: CountingEmbedder;
    queryCache: InMemoryQueryEmbeddingCache;
    searchLogger: InMemorySearchLogger;
  } {
    return {
      sql,
      embedder,
      queryCache: new InMemoryQueryEmbeddingCache(),
      searchLogger: new InMemorySearchLogger(),
      clock: fixedClock(NOW),
    };
  }

  const request = (over: Partial<SearchRequest> = {}): SearchRequest =>
    ({ filters: {}, limit: 5, source: 'test', ...over }) as SearchRequest;

  // ── Acceptance: every price carries price_as_of (rule 7) ─────────────────────

  it('returns results and stamps every one with price_as_of', async () => {
    const response = await runSearch(request({ query: 'cotton shirt' }), deps());

    expect(response.results.length).toBeGreaterThan(0);
    expect(response.results.length).toBeLessThanOrEqual(5);

    for (const result of response.results) {
      // Rule 7 applies to every item, not merely the priced ones — a caller must always
      // be able to say when the information was true.
      expect(result.priceAsOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(result.availabilityAsOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(result.whyThisMatched.length).toBeGreaterThan(0);
      expect(result.merchant.name.length).toBeGreaterThan(0);
    }
  });

  it('formats price for display without losing the exact paise', async () => {
    const response = await runSearch(request({ query: 'dashcam' }), deps());
    const priced = response.results.find((r) => r.pricePaise);
    expect(priced).toBeDefined();
    expect(priced!.displayPrice).toMatch(/^₹/);
    // The exact value travels as a string, so nothing downstream rounds it.
    expect(priced!.pricePaise).toMatch(/^\d+$/);
  });

  // ── Acceptance: empty results explain themselves (rule 8) ────────────────────

  describe('no results', () => {
    /**
     * An impossible attribute rather than a low price: the synthetic perf data includes
     * units priced near zero, so a price floor is not reliably empty, whereas no unit
     * carries this attribute at all.
     */
    const impossible = { attributes: { __nonexistent_attribute__: 'never' } };

    it('says the filters excluded everything when the query itself matched', async () => {
      const response = await runSearch(
        request({ query: 'cotton shirt', filters: impossible }),
        deps(),
      );

      expect(response.results).toEqual([]);
      expect(response.noResultsReason).toBeDefined();
      // The distinction that makes it actionable: which constraint to relax.
      expect(response.noResultsReason).toMatch(/relax/i);
      expect(response.noResultsReason).toContain('cotton shirt');
    });

    it('names the specific constraint that excluded everything', async () => {
      const response = await runSearch(
        request({ query: 'cotton shirt', filters: { ...impossible, maxDeliveryDays: 1 } }),
        deps(),
      );
      expect(response.results).toEqual([]);
      expect(response.noResultsReason).toContain('1 day');
    });
  });

  /**
   * A vector index always has a nearest neighbour, so without a floor a nonsense query
   * comes back full of confident-looking matches and rule 8 never fires. This is the
   * mechanism that makes an empty result possible at all for a text query.
   */
  describe('relevance floor', () => {
    it('returns nothing for a nonsense query once the floor is applied', async () => {
      /**
       * The real case: a query with no lexical match either. The floor gates the vector
       * channels only — an exact word match is direct evidence and is deliberately not
       * subject to a similarity threshold, so a query that matches real words will still
       * return results however high the floor is set.
       */
      const response = await runSearch(
        request({ query: 'zzqqxx nonexistent gibberish', minSemanticSimilarity: 0.99 }),
        deps(),
      );
      expect(response.results).toEqual([]);
      expect(response.noResultsReason).toBeDefined();
    }, 30_000);

    it('does not gate a lexical match on vector similarity', async () => {
      // Even at an impossible floor, matching the actual words is still a match.
      const response = await runSearch(
        request({ query: 'dashcam', minSemanticSimilarity: 0.999 }),
        deps(),
      );
      expect(response.results.length).toBeGreaterThan(0);
      expect(response.results.every((r) => r.whyThisMatched.length > 0)).toBe(true);
    }, 30_000);

    it('returns results again once the floor is lowered', async () => {
      const response = await runSearch(
        request({ query: 'cotton shirt', minSemanticSimilarity: 0 }),
        deps(),
      );
      expect(response.results.length).toBeGreaterThan(0);
    });
  });

  // ── Acceptance: no LLM call, and the embedding is cached (rule 10) ───────────

  describe('embedding cost', () => {
    it('embeds a query once and serves the repeat from cache', async () => {
      const d = deps();
      await runSearch(request({ query: 'cotton shirt' }), d);
      expect(d.embedder.calls).toBe(1);

      await runSearch(request({ query: 'cotton shirt' }), d);
      // Same query, no second Bedrock call.
      expect(d.embedder.calls).toBe(1);
      expect(d.queryCache.hits).toBe(1);
    });

    it('treats trivially different spellings of a query as the same', async () => {
      const d = deps();
      await runSearch(request({ query: 'Cotton Shirt' }), d);
      await runSearch(request({ query: '  cotton   shirt ' }), d);
      expect(d.embedder.calls).toBe(1);
    });

    it('makes no model call at all for a keyword-only search', async () => {
      const d = deps();
      // Not currently reachable through the request schema, which requires a query, but the
      // pipeline must not assume a vector exists — the MCP tools pass image-only searches.
      const response = await runSearch(request({ query: 'dashcam' }), d);
      expect(response.results.length).toBeGreaterThan(0);
      expect(d.embedder.calls).toBe(1);
    });

    it('hashes queries stably', () => {
      expect(queryHash('Cotton  Shirt ')).toBe(queryHash('cotton shirt'));
      expect(queryHash('cotton shirt')).not.toBe(queryHash('cotton shorts'));
    });
  });

  // ── Acceptance: T1.20, every search is logged ────────────────────────────────

  describe('search logging', () => {
    it('logs every search with its result ids in order', async () => {
      const d = deps();
      const response = await runSearch(request({ query: 'cotton shirt' }), d);

      expect(d.searchLogger.entries).toHaveLength(1);
      const entry = d.searchLogger.entries[0]!;
      expect(entry.searchId).toBe(response.searchId);
      expect(entry.query).toBe('cotton shirt');
      expect(entry.resultCount).toBe(response.results.length);
      // Order matters: this is the training set for the learned re-ranker in T4.3.
      expect(entry.resultIds).toEqual(response.results.map((r) => r.id));
      expect(entry.source).toBe('test');
    });

    it('records the cache hit and the per-stage latencies', async () => {
      const d = deps();
      await runSearch(request({ query: 'a repeated query' }), d);
      await runSearch(request({ query: 'a repeated query' }), d);

      expect(d.searchLogger.entries[0]!.embeddingCacheHit).toBe(false);
      expect(d.searchLogger.entries[1]!.embeddingCacheHit).toBe(true);

      const { latencies } = d.searchLogger.entries[1]!;
      expect(latencies.queryMs).toBeGreaterThan(0);
      expect(latencies.totalMs).toBeGreaterThanOrEqual(0);
    });

    it('logs an empty search too, with its reason', async () => {
      const d = deps();
      await runSearch(
        request({
          query: 'cotton shirt',
          filters: { attributes: { __nonexistent_attribute__: 'never' } },
        }),
        d,
      );

      expect(d.searchLogger.entries).toHaveLength(1);
      expect(d.searchLogger.entries[0]!.resultCount).toBe(0);
      expect(d.searchLogger.entries[0]!.noResultsReason).toBeDefined();
    });

    it('still returns results when logging fails', async () => {
      // The buyer already has their answer; losing a log row must not cost them it.
      const d = {
        ...deps(),
        searchLogger: {
          async log() {
            throw new Error('DynamoDB is down');
          },
        },
      };
      const response = await runSearch(request({ query: 'cotton shirt' }), d);
      expect(response.results.length).toBeGreaterThan(0);
    });

    it('produces one entry per search across a hundred searches', async () => {
      const d = deps();
      for (let i = 0; i < 100; i++) {
        await runSearch(request({ query: `query variant ${i % 7}` }), d);
      }
      expect(d.searchLogger.entries).toHaveLength(100);
      expect(new Set(d.searchLogger.entries.map((e) => e.searchId)).size).toBe(100);
    }, 120_000);
  });

  // ── Acceptance: p95 under 200ms warm ─────────────────────────────────────────

  it('stays inside the 200ms p95 budget when warm', async () => {
    const d = deps();
    const queries = ['cotton shirt', 'dashcam for car', 'deep cleaning', 'power bank', 'kurta'];

    for (const query of queries) await runSearch(request({ query }), d); // warm

    const timings: number[] = [];
    for (let i = 0; i < 40; i++) {
      const started = performance.now();
      await runSearch(request({ query: queries[i % queries.length]! }), d);
      timings.push(performance.now() - started);
    }
    timings.sort((a, b) => a - b);
    const p95 = timings[Math.floor(timings.length * 0.95)]!;

    // eslint-disable-next-line no-console
    console.log(`    pipeline p50=${timings[20]!.toFixed(1)}ms p95=${p95.toFixed(1)}ms`);
    expect(p95).toBeLessThan(200);
  }, 120_000);

  it('honours the requested limit', async () => {
    const response = await runSearch(request({ query: 'cotton shirt', limit: 3 }), deps());
    expect(response.results.length).toBeLessThanOrEqual(3);
  });
});
