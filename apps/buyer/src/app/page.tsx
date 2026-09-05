'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, describeError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatPaise } from '../lib/format';
import type { SearchResponse, SearchResultItem } from '../lib/types';
import { PromptInput, Suggestions } from '../components/chat/prompt-input';
import { ProductCard } from '../components/chat/product-card';
import { BuyFlow } from '../components/chat/buy-flow';

/**
 * The ask surface.
 *
 * This was a search box with a results grid under it, and it worked, and it was the wrong
 * shape. Someone shopping through an assistant is having a conversation — they say what
 * they need, look at what comes back, change their mind, and buy — and a page that answers
 * in a static grid makes them do the conversational part in their head.
 *
 * So the thread is the surface. A question goes in, cards come back *in* the thread, the
 * refinements are things you can tap rather than rephrase, and buying happens where you are
 * rather than on a checkout page you had to leave for.
 *
 * **Nothing here is generated.** There is no model in this path: the sentence above each set
 * of results is composed from the results themselves — a count, a real cheapest price, a
 * real fastest delivery — and when nothing matches it states the API's own
 * `noResultsReason` verbatim. A shopping assistant that improvises a reassuring sentence
 * about products it did not find is the exact failure this whole system is built to avoid.
 */

interface Filters {
  maxPriceInr?: number;
  maxDeliveryDays?: number;
  inStockOnly?: boolean;
}

type Turn =
  | { kind: 'ask'; id: string; text: string }
  | {
      kind: 'answer';
      id: string;
      query: string;
      filters: Filters;
      loading: boolean;
      response?: SearchResponse;
      error?: string;
    }
  | { kind: 'buy'; id: string; item: SearchResultItem; variantId?: string; variantLabel: string };

const SUGGESTIONS = [
  { label: 'Gift', prompt: 'a thoughtful gift under ₹2,000 for someone who cooks' },
  { label: 'Food', prompt: 'snacks and dry fruits for a house full of guests' },
  { label: 'Travel', prompt: 'a cabin bag that survives Indian airports' },
  { label: 'Services', prompt: 'deep clean my 2BHK before Diwali' },
];

let counter = 0;
const nextId = () => `t${++counter}`;

export default function AskPage() {
  const { status } = useAuth();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (status !== 'signedIn') return;
    void api
      .get<{ name: string | null }>('/buyer/me')
      .then((me) => setName(firstName(me.name)))
      .catch(() => undefined);
  }, [status]);

  // The newest turn is the one being read, so it is the one kept in view.
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns]);

  const ask = useCallback(async (text: string, filters: Filters = {}) => {
    const answerId = nextId();
    setBusy(true);
    setTurns((prev) => [
      ...prev,
      { kind: 'ask', id: nextId(), text },
      { kind: 'answer', id: answerId, query: text, filters, loading: true },
    ]);

    try {
      const response = await api.post<SearchResponse>('/search', {
        query: text,
        filters,
        limit: 10,
        source: 'web',
      });
      setTurns((prev) =>
        prev.map((t) => (t.id === answerId ? { ...t, loading: false, response } : t)),
      );
    } catch (err) {
      setTurns((prev) =>
        prev.map((t) =>
          t.id === answerId ? { ...t, loading: false, error: describeError(err) } : t,
        ),
      );
    } finally {
      setBusy(false);
    }
  }, []);

  const buy = useCallback(
    (choice: { item: SearchResultItem; variantId?: string; label: string }) => {
      setTurns((prev) => [
        ...prev,
        {
          kind: 'buy',
          id: nextId(),
          item: choice.item,
          ...(choice.variantId ? { variantId: choice.variantId } : {}),
          variantLabel: choice.label,
        },
      ]);
    },
    [],
  );

  const empty = turns.length === 0;

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col px-5">
      {empty ? (
        <Opening name={name} onPick={(p) => void ask(p)} busy={busy} />
      ) : (
        <>
          <div className="flex-1 space-y-8 pb-40 pt-10">
            {turns.map((turn) => (
              <TurnView key={turn.id} turn={turn} onBuy={buy} onRefine={ask} />
            ))}
            <div ref={bottom} />
          </div>

          {/* Docked once the conversation exists: the input belongs at the point the next
              thing is said, not floating in the middle of what was already answered. */}
          <div className="fixed inset-x-0 bottom-0 z-20 bg-gradient-to-t from-[hsl(var(--surface))] via-[hsl(var(--surface))] to-transparent pb-24 pt-8">
            <div className="mx-auto w-full max-w-3xl px-5">
              <PromptInput onSubmit={(v) => void ask(v)} busy={busy} placeholder="Ask for something else…" />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The first screen, which is mostly nothing.
 *
 * The emptiness is the design. A buyer arriving here has not decided what they want yet, and
 * a wall of merchandising decides it for them badly — every retail homepage in existence is
 * an argument for whatever the retailer needs to move. One question, one input, four ways in.
 */
function Opening({
  name,
  onPick,
  busy,
}: {
  name: string | null;
  onPick: (prompt: string) => void;
  busy: boolean;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <div className="pt-10">
        <p className="text-[15px] text-[hsl(var(--muted))]">{greeting()},</p>
        {name && <p className="text-[15px] font-medium">{name}</p>}
      </div>

      <div className="flex flex-1 flex-col justify-center pb-32">
        <div className="cr-rise space-y-3 text-center">
          <h1 className="text-[34px] font-semibold tracking-tight sm:text-[40px]">Need anything?</h1>
          <p className="mx-auto max-w-sm text-[15px] leading-relaxed text-[hsl(var(--muted))]">
            Tell me what you&rsquo;re looking for.
            <br />
            I&rsquo;ll find what actually fits.
          </p>
        </div>

        <div className="mx-auto mt-10 w-full max-w-xl space-y-5">
          <PromptInput onSubmit={onPick} busy={busy} autoFocus />
          <Suggestions items={SUGGESTIONS} onPick={onPick} disabled={busy} />
        </div>
      </div>
    </div>
  );
}

function TurnView({
  turn,
  onBuy,
  onRefine,
}: {
  turn: Turn;
  onBuy: (choice: { item: SearchResultItem; variantId?: string; label: string }) => void;
  onRefine: (text: string, filters: Filters) => void;
}) {
  if (turn.kind === 'ask') {
    return (
      <div className="flex justify-end">
        <p className="max-w-[80%] rounded-2xl rounded-br-md bg-[hsl(var(--accent))] px-4 py-2.5 text-[15px] text-white">
          {turn.text}
        </p>
      </div>
    );
  }

  if (turn.kind === 'buy') {
    return (
      <div className="cr-rise max-w-[560px]">
        <BuyFlow item={turn.item} variantId={turn.variantId} variantLabel={turn.variantLabel} />
      </div>
    );
  }

  if (turn.loading) {
    return (
      <div className="flex items-center gap-2 text-[15px] text-[hsl(var(--muted))]">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[hsl(var(--muted))]" />
        Looking through the catalogue…
      </div>
    );
  }

  if (turn.error) {
    return <p className="text-[15px] text-[hsl(var(--danger))]">{turn.error}</p>;
  }

  const results = turn.response?.results ?? [];

  if (results.length === 0) {
    return (
      <p className="max-w-[560px] text-[15px] leading-relaxed text-[hsl(var(--muted))]">
        {/* Rule 8's sentence, stated rather than paraphrased. */}
        {turn.response?.noResultsReason ?? 'Nothing matched that.'}
      </p>
    );
  }

  return (
    <div className="cr-rise space-y-4">
      <p className="text-[15px] leading-relaxed">{summarise(results)}</p>

      {/* Horizontal, snapping, and scrollable on its own — five cards across a phone is a
          grid nobody scrolls to the end of. */}
      <div className="-mx-5 flex snap-x snap-mandatory gap-3 overflow-x-auto px-5 pb-2">
        {results.map((item) => (
          <ProductCard key={item.id} item={item} onBuy={onBuy} />
        ))}
      </div>

      <Refinements results={results} onPick={(f) => onRefine(turn.query, { ...turn.filters, ...f })} />

      <p className="text-[11px] text-[hsl(var(--muted))]">
        {/* Rule 7. A price with no time attached is a claim about now made from data that
            is not. */}
        Prices and stock as of {new Date(results[0]!.priceAsOf).toLocaleTimeString('en-IN', {
          timeZone: 'Asia/Kolkata',
          hour: '2-digit',
          minute: '2-digit',
        })} IST.
      </p>
    </div>
  );
}

/**
 * The refinements, offered as taps.
 *
 * Every one is a hard exclusion in the query, not a ranking nudge — an item that cannot
 * arrive in time does not appear at all, however cheap it is. Offering them as buttons is
 * what makes that legible: change the budget, watch things disappear, understand in one
 * interaction what a paragraph about constraint handling could not explain.
 */
function Refinements({
  results,
  onPick,
}: {
  results: SearchResultItem[];
  onPick: (filters: Filters) => void;
}) {
  const prices = results
    .map((r) => (r.pricePaise ? Number(BigInt(r.pricePaise) / 100n) : null))
    .filter((n): n is number => n !== null);

  // A budget only worth offering if it would actually exclude something.
  const median = prices.length > 0 ? prices.sort((a, b) => a - b)[Math.floor(prices.length / 2)]! : 0;
  const budget = median > 0 ? Math.round(median / 500) * 500 : 0;

  const options: { label: string; filters: Filters }[] = [
    ...(budget > 0 ? [{ label: `Under ₹${budget.toLocaleString('en-IN')}`, filters: { maxPriceInr: budget } }] : []),
    { label: 'Arrives in 2 days', filters: { maxDeliveryDays: 2 } },
    { label: 'In stock only', filters: { inStockOnly: true } },
  ];

  return (
    <div className="flex flex-wrap gap-2">
      {options.map((option) => (
        <button
          key={option.label}
          type="button"
          onClick={() => onPick(option.filters)}
          className="rounded-full border border-[hsl(var(--border))] bg-[hsl(var(--bg))] px-3 py-1.5 text-[12.5px] font-medium text-[hsl(var(--muted))] transition hover:border-[hsl(var(--accent))] hover:text-[hsl(var(--text))]"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * One sentence about the results, assembled from the results.
 *
 * Deliberately dull. It names a count, a real cheapest price and a real fastest delivery,
 * all of which are on the cards below it and can be checked against them. Anything more
 * fluent would have to come from somewhere other than the data.
 */
function summarise(results: SearchResultItem[]): string {
  const count = results.length;
  const priced = results.filter((r) => r.pricePaise);
  const cheapest = priced.reduce<SearchResultItem | null>(
    (best, r) => (!best || BigInt(r.pricePaise!) < BigInt(best.pricePaise!) ? r : best),
    null,
  );

  const parts = [`${count} ${count === 1 ? 'match' : 'matches'}.`];
  if (cheapest) parts.push(`From ${formatPaise(cheapest.pricePaise!)}.`);

  const fastest = results.find((r) => r.deliveryEstimate);
  if (fastest?.deliveryEstimate) parts.push(`Soonest ${fastest.deliveryEstimate}.`);

  return parts.join(' ');
}

function greeting(): string {
  const hour = Number(
    new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }),
  );
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function firstName(name: string | null): string | null {
  const first = (name ?? '').trim().split(/\s+/)[0];
  return first ? first : null;
}
