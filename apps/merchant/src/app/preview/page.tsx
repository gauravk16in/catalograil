'use client';

import { useState } from 'react';
import { api, describeError } from '../../lib/api';
import { useSession } from '../../lib/session';
import { formatPaise, relativeTime } from '../../lib/format';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Empty,
  ErrorNote,
  Field,
  inputClass,
} from '../../components/ui';

/**
 * T1.25 — "Preview in AI". The retention feature.
 *
 * A merchant types what a shopper would ask and sees the real ranked results, with their
 * own products marked and their rank shown. The part that makes it a tool rather than a
 * demo is the second half of T1.25: when their product does *not* appear, say why —
 * filtered out on price, on stock, on delivery, or simply not relevant enough.
 *
 * That distinction is the whole value. "You're not ranking" is a complaint; "you're
 * excluded because your delivery estimate is 9 days and the shopper asked for 3" is
 * something a merchant can go and fix this afternoon.
 */

interface SearchResultItem {
  id: string;
  productId: string;
  name: string;
  brand?: string;
  displayPrice?: string;
  pricePaise?: string;
  priceAsOf: string;
  availability: 'in_stock' | 'out_of_stock' | 'unknown';
  deliveryEstimate?: string;
  whyThisMatched: string;
  merchant: {
    id: string;
    name: string;
    trust: { score: number; newMerchant: boolean; signals: string[] };
  };
}

interface SearchResponse {
  results: SearchResultItem[];
  noResultsReason?: string;
  searchId: string;
  tookMs: number;
}

/** Reasons a merchant's own product was absent, in the order worth acting on. */
interface Diagnosis {
  readonly verdict: string;
  readonly detail: string;
  readonly tone: 'warn' | 'danger' | 'neutral';
}

export default function PreviewPage() {
  const { session } = useSession();
  const [query, setQuery] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [maxDeliveryDays, setMaxDeliveryDays] = useState('');
  const [inStockOnly, setInStockOnly] = useState(false);

  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [ownResults, setOwnResults] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(event: React.FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;

    setLoading(true);
    setError(null);

    const filters = {
      ...(maxPrice ? { maxPriceInr: Number(maxPrice) } : {}),
      ...(maxDeliveryDays ? { maxDeliveryDays: Number(maxDeliveryDays) } : {}),
      ...(inStockOnly ? { inStockOnly: true } : {}),
    };

    try {
      /**
       * Two searches, deliberately.
       *
       * The first is what a shopper actually sees. The second is the same query restricted
       * to this merchant, with the filters dropped — that is what makes the diagnosis
       * possible: if their product exists and is relevant but did not appear in the first,
       * the constraints are what excluded it, and comparing the two says which.
       */
      const [everyone, mine] = await Promise.all([
        api.post<SearchResponse>('/merchant/search-preview', {
          query,
          filters,
          limit: 20,
          source: 'dashboard',
        }),
        api.post<SearchResponse>('/merchant/search-preview', {
          query,
          // Restricted to this merchant and stripped of the shopper's constraints, so the
          // diagnosis below can tell "excluded by a filter" from "not relevant enough".
          filters: session ? { merchantId: session.merchantId } : {},
          limit: 20,
          source: 'dashboard',
        }),
      ]);

      setResponse(everyone);
      setOwnResults(mine);
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
        <h1 className="text-xl font-semibold tracking-tight">Preview in AI</h1>
        <p className="mt-1.5 max-w-2xl text-sm text-[hsl(var(--muted))]">
          Type what a shopper would ask an assistant. These are the real results, ranked the same
          way — including where your products land, and why they do or do not.
        </p>
      </div>

      <Card>
        <form onSubmit={run} className="space-y-4 px-5 py-5">
          <Field label="What would a shopper ask?" hint="Describe the need, not the product name.">
            <input
              className={inputClass}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="a formal shirt I can wear to an office in Chennai"
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Budget (₹)" hint="Optional">
              <input
                className={inputClass}
                inputMode="numeric"
                value={maxPrice}
                onChange={(e) => setMaxPrice(e.target.value.replace(/\D/g, ''))}
                placeholder="2000"
              />
            </Field>
            <Field label="Needs it within (days)" hint="Optional">
              <input
                className={inputClass}
                inputMode="numeric"
                value={maxDeliveryDays}
                onChange={(e) => setMaxDeliveryDays(e.target.value.replace(/\D/g, ''))}
                placeholder="3"
              />
            </Field>
            <div className="flex items-end pb-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={inStockOnly}
                  onChange={(e) => setInStockOnly(e.target.checked)}
                />
                In stock only
              </label>
            </div>
          </div>

          <Button type="submit" disabled={loading || !query.trim()}>
            {loading ? 'Searching…' : 'Search as a shopper'}
          </Button>
        </form>
      </Card>

      {error && <ErrorNote>{error}</ErrorNote>}

      {response && (
        <>
          <YourStanding
            response={response}
            unfiltered={ownResults}
            merchantId={session?.merchantId}
            filters={{ maxPrice, maxDeliveryDays, inStockOnly }}
          />
          <Results response={response} merchantId={session?.merchantId} />
        </>
      )}
    </div>
  );
}

/**
 * The half of T1.25 that turns this from a demo into a daily tool.
 *
 * Note what it never says: "improve your listing". A merchant who is told their product
 * ranks 14th deserves to know which signal put it there, and every branch below names one
 * they can actually change.
 */
function YourStanding({
  response,
  unfiltered,
  merchantId,
  filters,
}: {
  response: SearchResponse;
  unfiltered: SearchResponse | null;
  merchantId: string | undefined;
  filters: { maxPrice: string; maxDeliveryDays: string; inStockOnly: boolean };
}) {
  const mine = response.results
    .map((r, i) => ({ ...r, rank: i + 1 }))
    .filter((r) => r.merchant.id === merchantId);
  const inTop20 = mine.length > 0;

  const diagnosis: Diagnosis | null = inTop20 ? null : diagnose(unfiltered, merchantId, filters);

  return (
    <Card>
      <CardHeader
        title="Where you rank"
        description={`${response.results.length} results in ${response.tookMs}ms`}
      />
      <div className="px-5 py-5">
        {inTop20 ? (
          <ul className="space-y-3">
            {mine.map((result) => (
              <li key={result.id} className="flex items-start gap-3">
                <Badge tone="accent">#{result.rank}</Badge>
                <div>
                  <p className="text-sm font-medium">{result.name}</p>
                  <p className="mt-0.5 text-sm text-[hsl(var(--muted))]">{result.whyThisMatched}</p>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Badge tone={diagnosis?.tone ?? 'neutral'}>Not in the top 20</Badge>
            </div>
            <p className="text-sm font-medium">
              {diagnosis?.verdict ?? 'No matching product of yours.'}
            </p>
            <p className="max-w-2xl text-sm text-[hsl(var(--muted))]">{diagnosis?.detail ?? ''}</p>
          </div>
        )}
      </div>
    </Card>
  );
}

/**
 * Distinguishes "your product was excluded by a filter" from "your product is not relevant
 * enough" — different problems with different fixes, and a merchant told the wrong one
 * wastes their afternoon.
 */
function diagnose(
  unfiltered: SearchResponse | null,
  merchantId: string | undefined,
  filters: { maxPrice: string; maxDeliveryDays: string; inStockOnly: boolean },
): Diagnosis {
  const mineUnfiltered = unfiltered?.results.filter((r) => r.merchant.id === merchantId) ?? [];

  if (mineUnfiltered.length === 0) {
    return {
      verdict: 'None of your products match this query closely enough.',
      detail:
        'The words a shopper uses are matched against your product name, description and the use cases we generate. If this is a query you should win, adding the phrasing a buyer would actually use to the description is the fastest fix.',
      tone: 'neutral',
    };
  }

  const best = mineUnfiltered[0]!;
  const applied: string[] = [];
  if (filters.maxPrice) applied.push(`a ₹${filters.maxPrice} budget`);
  if (filters.maxDeliveryDays) applied.push(`delivery within ${filters.maxDeliveryDays} days`);
  if (filters.inStockOnly) applied.push('in-stock only');

  if (applied.length > 0) {
    return {
      verdict: `"${best.name}" matches this query, but was excluded by the shopper's constraints.`,
      detail: `The shopper asked for ${applied.join(' and ')}. Constraints are hard exclusions rather than ranking penalties — a product that cannot meet one does not appear at all, however well it matches otherwise. ${
        best.availability === 'out_of_stock'
          ? 'This one is currently out of stock.'
          : best.deliveryEstimate
            ? `This one is listed as "${best.deliveryEstimate}".`
            : ''
      }`,
      tone: 'warn',
    };
  }

  return {
    verdict: `"${best.name}" matches, but other merchants ranked above it.`,
    detail:
      'Ranking weighs how well the text matches, your trust score, delivery speed and how recently the listing was updated. Faster delivery and a fuller description are the two you can change today.',
    tone: 'neutral',
  };
}

function Results({
  response,
  merchantId,
}: {
  response: SearchResponse;
  merchantId: string | undefined;
}) {
  if (response.results.length === 0) {
    return (
      <Card>
        <Empty
          title="No results"
          // Rule 8's sentence, surfaced verbatim rather than paraphrased.
          reason={response.noResultsReason ?? 'Nothing matched this query.'}
        />
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="What the shopper sees"
        description="Ranked exactly as an assistant would receive them."
      />
      <ol className="divide-y divide-[hsl(var(--border))]">
        {response.results.map((result, index) => {
          const isMine = result.merchant.id === merchantId;
          return (
            <li
              key={result.id}
              className={`px-5 py-4 ${isMine ? 'bg-[hsl(var(--accent-soft))]' : ''}`}
            >
              <div className="flex items-start gap-4">
                <span className="w-6 shrink-0 text-sm tabular-nums text-[hsl(var(--muted))]">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium">{result.name}</p>
                    {isMine && <Badge tone="accent">Yours</Badge>}
                    {result.availability === 'out_of_stock' && (
                      <Badge tone="warn">Out of stock</Badge>
                    )}
                  </div>
                  <p className="mt-0.5 text-sm text-[hsl(var(--muted))]">{result.whyThisMatched}</p>
                  <p className="mt-1.5 text-xs text-[hsl(var(--muted))]">
                    {result.merchant.name}
                    {result.merchant.trust.signals.length > 0 &&
                      ` · ${result.merchant.trust.signals.join(' · ')}`}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm font-medium tabular-nums">
                    {result.displayPrice ?? formatPaise(result.pricePaise ?? null)}
                  </p>
                  {/* Rule 7: the price is never shown without when it was true. */}
                  <p className="mt-0.5 text-xs text-[hsl(var(--muted))]">
                    as of {relativeTime(result.priceAsOf)}
                  </p>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
