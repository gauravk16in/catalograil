'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, describeError } from '../lib/api';
import { formatPaise, relativeTime } from '../lib/format';
import { Badge, Button, Card, Empty, ErrorNote } from '../components/ui';
import { ProductImage } from '../components/product-image';
import { ProductDetail } from '../components/product-detail';
import { Glow } from '../components/glow';
import { ResultSkeleton, SearchStage } from '../components/search-stage';
import { FilterBar, type Filters } from '../components/filters';

/**
 * The buyer-facing search surface.
 *
 * This is the same `/internal/search` an assistant calls through MCP, rendered for a
 * person. Keeping them on one endpoint matters: if the web surface and the assistant ever
 * disagreed about what a query returns, the assistant is the one nobody can debug.
 *
 * Two things are shown here that a conventional storefront omits, and both are deliberate.
 * Every price carries when it was last known true (rule 7), and every result says why it
 * matched — because a buyer being answered by an AI has no way to check either otherwise.
 */

export interface SearchResultItem {
  id: string;
  /** The product, for opening detail. `id` is the variant, which is what gets bought. */
  productId: string;
  name: string;
  brand?: string;
  displayPrice?: string;
  pricePaise?: string;
  priceAsOf: string;
  availability: 'in_stock' | 'out_of_stock' | 'unknown';
  deliveryEstimate?: string;
  options?: Record<string, string>;
  images: string[];
  whyThisMatched: string;
  merchant: {
    id: string;
    name: string;
    city?: string;
    trust: { score: number; newMerchant: boolean; signals: string[] };
  };
}

interface SearchResponse {
  results: SearchResultItem[];
  noResultsReason?: string;
  tookMs: number;
}

const EXAMPLES = [
  'a formal shirt for an office in Chennai',
  'dashcam that records at night',
  'deep clean my 2BHK before Diwali',
];

export default function BuyerSearch() {
  const [query, setQuery] = useState('');
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<SearchResultItem | null>(null);
  const [filters, setFilters] = useState<Filters>({});
  const [focused, setFocused] = useState(false);
  const [cursor, setCursor] = useState(-1);
  const lastQuery = useRef('');

  const run = useCallback(async (value: string, withFilters: Filters) => {
    if (!value.trim()) return;
    lastQuery.current = value;
    setQuery(value);
    setLoading(true);
    setError(null);
    setCursor(-1);

    try {
      setResponse(
        await api.post<SearchResponse>('/search', {
          query: value,
          filters: withFilters,
          limit: 10,
          source: 'web',
        }),
      );
    } catch (err) {
      setError(describeError(err));
      setResponse(null);
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Changing a filter re-runs the search immediately.
   *
   * That immediacy is the point of the controls: a buyer drops the budget and watches items
   * disappear, which teaches in one interaction what a paragraph of copy about hard
   * exclusions could not.
   */
  useEffect(() => {
    if (!lastQuery.current) return;
    void run(lastQuery.current, filters);
    // Intentionally keyed on `filters` alone: `run` is stable via useCallback, and including
    // it would only add noise.
  }, [filters, run]);

  /**
   * `?product=<id>` opens straight to that product.
   *
   * This is the link an assistant hands out alongside a search result — a buyer being shown
   * a card inside Claude needs somewhere to go that shows them the same item, the merchant's
   * own policy text and a way to pay, without making them search again for the thing they
   * were just looking at.
   *
   * A stub is enough to open the panel: it fetches the real detail from `productId` itself,
   * and having no variant id simply means it defaults to the first one rather than the
   * matched one.
   */
  useEffect(() => {
    const productId = new URLSearchParams(window.location.search).get('product');
    if (!productId) return;

    setOpened({
      id: '',
      productId,
      name: '',
      priceAsOf: new Date().toISOString(),
      availability: 'unknown',
      images: [],
      whyThisMatched: '',
      merchant: { id: '', name: '', trust: { score: 0, newMerchant: true, signals: [] } },
    });
  }, []);

  /**
   * Arrow keys move through results, Enter opens one.
   *
   * Someone comparing four shirts should not have to move their hand to the mouse between
   * each — and it costs nothing to support.
   */
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const results = response?.results ?? [];
      if (results.length === 0 || opened) return;

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setCursor((c) => Math.min(c + 1, results.length - 1));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setCursor((c) => Math.max(c - 1, -1));
      } else if (event.key === 'Enter' && cursor >= 0) {
        setOpened(results[cursor] ?? null);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [response, cursor, opened]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Describe what you need</h1>
        <p className="mt-1.5 text-sm text-[hsl(var(--muted))]">
          Not a product name — what it is for. The same search an AI assistant runs on your behalf.
        </p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(query, filters);
        }}
        className="space-y-3"
      >
        {/* The border lights while the box has focus or a search is running — the one place
            movement earns its keep, because it marks where the buyer is typing. */}
        <Glow active={focused || loading}>
          <div className="flex items-center gap-2 px-2 py-1.5">
            <input
              className="w-full bg-transparent px-2 py-2 text-base outline-none placeholder:text-[hsl(var(--muted))]"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              placeholder="something to wear to a friend's wedding"
              aria-label="Describe what you need"
            />
            <Button type="submit" disabled={loading || !query.trim()}>
              {loading ? 'Searching' : 'Search'}
            </Button>
          </div>
        </Glow>

        <FilterBar filters={filters} onChange={setFilters} disabled={loading} />
      </form>

      {!response && !loading && (
        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((example) => (
            <button
              key={example}
              onClick={() => void run(example, filters)}
              className="rounded-full border border-[hsl(var(--border))] bg-[hsl(var(--bg))] px-3 py-1.5 text-sm text-[hsl(var(--muted))] hover:text-[hsl(var(--text))]"
            >
              {example}
            </button>
          ))}
        </div>
      )}

      {error && <ErrorNote>{error}</ErrorNote>}

      {loading && (
        <div className="space-y-3">
          <SearchStage query={query} />
          {[0, 1, 2].map((i) => (
            <ResultSkeleton key={i} />
          ))}
        </div>
      )}

      {opened && <ProductDetail result={opened} onClose={() => setOpened(null)} />}

      {response &&
        !loading &&
        (response.results.length === 0 ? (
          <Card>
            {/* Rule 8's sentence, shown as written rather than replaced with "no results". */}
            <Empty title="Nothing matched" reason={response.noResultsReason} />
          </Card>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-[hsl(var(--muted))]">
              {response.results.length} results in {response.tookMs}ms
              {response.results.length > 1 && ' · ↑↓ to move, Enter to open'}
            </p>
            {response.results.map((result, index) => (
              <div
                key={result.id}
                className="cr-rise"
                // Staggered, so the answer reads as assembling rather than appearing whole.
                style={{ animationDelay: `${Math.min(index, 6) * 45}ms` }}
              >
                <ResultCard
                  result={result}
                  onOpen={setOpened}
                  selected={index === cursor}
                />
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}

function ResultCard({
  result,
  onOpen,
  selected,
}: {
  result: SearchResultItem;
  onOpen: (result: SearchResultItem) => void;
  selected?: boolean;
}) {
  return (
    /*
      The whole card is the target, not a link buried in the title.
      A buyer scanning results taps the picture or the price as readily as the name, and a
      card that only responds in one place reads as not responding at all.
    */
    <Card
      className={`overflow-hidden transition ${
        selected
          ? 'border-[hsl(var(--accent))] ring-2 ring-[hsl(var(--accent-soft))]'
          : 'hover:border-[hsl(var(--text))]'
      }`}
    >
      <button
        type="button"
        onClick={() => onOpen(result)}
        className="flex w-full items-start gap-4 p-5 text-left"
      >
        <ProductImage
          src={result.images?.[0]}
          alt={result.name}
          className="h-24 w-24 shrink-0 rounded-lg"
        />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-medium">{result.name}</h2>
            {result.availability === 'out_of_stock' && <Badge tone="warn">Out of stock</Badge>}
          </div>

          {result.options && Object.keys(result.options).length > 0 && (
            <p className="mt-0.5 text-xs text-[hsl(var(--muted))]">
              {Object.entries(result.options)
                .map(([key, value]) => `${key}: ${value}`)
                .join(' · ')}
            </p>
          )}

          <p className="mt-1.5 text-sm text-[hsl(var(--muted))]">{result.whyThisMatched}</p>

          {result.deliveryEstimate && (
            <p className="mt-1 text-sm text-[hsl(var(--ok))]">{result.deliveryEstimate}</p>
          )}

          <div className="mt-3 border-t border-[hsl(var(--border))] pt-3">
            <p className="text-sm font-medium">{result.merchant.name}</p>
            {/*
              Trust as statements rather than a score. "0.87" tells a buyer nothing about
              whether to hand over money; "312 orders fulfilled" does.
            */}
            <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
              {result.merchant.trust.signals.map((signal) => (
                <li key={signal} className="text-xs text-[hsl(var(--muted))]">
                  {signal}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="shrink-0 text-right">
          <p className="text-base font-semibold tabular-nums">
            {result.displayPrice ?? formatPaise(result.pricePaise ?? null)}
          </p>
          {/* Rule 7 on the buyer surface too: never a bare number. */}
          <p className="mt-0.5 text-xs text-[hsl(var(--muted))]">
            price as of {relativeTime(result.priceAsOf)}
          </p>
        </div>
      </button>
    </Card>
  );
}
