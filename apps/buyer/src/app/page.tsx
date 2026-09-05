'use client';

import { useState } from 'react';
import { api, describeError } from '../lib/api';
import { formatPaise, relativeTime } from '../lib/format';
import { Badge, Button, Card, Empty, ErrorNote, inputClass } from '../components/ui';
import { ProductImage } from '../components/product-image';
import { ProductDetail } from '../components/product-detail';

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

  async function run(value: string) {
    if (!value.trim()) return;
    setQuery(value);
    setLoading(true);
    setError(null);

    try {
      setResponse(
        await api.post<SearchResponse>('/search', {
          query: value,
          filters: {},
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
  }

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
          void run(query);
        }}
        className="flex gap-2"
      >
        <input
          className={inputClass}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="something to wear to a friend's wedding"
        />
        <Button type="submit" disabled={loading || !query.trim()}>
          {loading ? 'Searching…' : 'Search'}
        </Button>
      </form>

      {!response && !loading && (
        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((example) => (
            <button
              key={example}
              onClick={() => void run(example)}
              className="rounded-full border border-[hsl(var(--border))] bg-[hsl(var(--bg))] px-3 py-1.5 text-sm text-[hsl(var(--muted))] hover:text-[hsl(var(--text))]"
            >
              {example}
            </button>
          ))}
        </div>
      )}

      {error && <ErrorNote>{error}</ErrorNote>}

      {opened && <ProductDetail result={opened} onClose={() => setOpened(null)} />}

      {response &&
        (response.results.length === 0 ? (
          <Card>
            {/* Rule 8's sentence, shown as written rather than replaced with "no results". */}
            <Empty title="Nothing matched" reason={response.noResultsReason} />
          </Card>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-[hsl(var(--muted))]">
              {response.results.length} results in {response.tookMs}ms
            </p>
            {response.results.map((result) => (
              <ResultCard key={result.id} result={result} onOpen={setOpened} />
            ))}
          </div>
        ))}
    </div>
  );
}

function ResultCard({
  result,
  onOpen,
}: {
  result: SearchResultItem;
  onOpen: (result: SearchResultItem) => void;
}) {
  return (
    /*
      The whole card is the target, not a link buried in the title.
      A buyer scanning results taps the picture or the price as readily as the name, and a
      card that only responds in one place reads as not responding at all.
    */
    <Card className="overflow-hidden transition hover:border-[hsl(var(--fg))]">
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
