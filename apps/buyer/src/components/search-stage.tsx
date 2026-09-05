'use client';

import { useEffect, useState } from 'react';
import { ThinkingOrb } from 'thinking-orbs';

/**
 * What the search is doing, while it does it.
 *
 * A spinner says "wait"; this says what is being waited for. That matters here more than on
 * a normal storefront, because the interesting claim of this product is that a sentence is
 * being *understood* rather than string-matched — and a buyer who never sees that happen has
 * no reason to believe it.
 *
 * The stages are real: the query is embedded, three channels are searched, and the results
 * are reranked. The timings are approximations of the measured p50, so the text keeps pace
 * with a fast search rather than flashing through.
 */
const STAGES = [
  { at: 0, label: 'Reading what you asked for' },
  { at: 320, label: 'Matching on meaning, not just words' },
  { at: 900, label: 'Ranking by trust and delivery' },
] as const;

export function SearchStage({ query }: { query: string }) {
  const [stage, setStage] = useState(0);

  useEffect(() => {
    setStage(0);
    const timers = STAGES.slice(1).map((s, i) =>
      setTimeout(() => setStage(i + 1), s.at),
    );
    return () => timers.forEach(clearTimeout);
  }, [query]);

  return (
    <div className="flex items-center gap-3 rounded-xl border border-[hsl(var(--border))] px-5 py-4">
      {/* `searching` is the library's own state for exactly this. */}
      <ThinkingOrb state="searching" size={20} aria-label="Searching" />
      <div className="min-w-0">
        <p className="text-sm">{STAGES[stage]!.label}</p>
        <p className="truncate text-xs text-[hsl(var(--muted))]">“{query}”</p>
      </div>
    </div>
  );
}

/**
 * A result-shaped placeholder.
 *
 * Shaped like the thing that is coming rather than a generic bar, so the page does not
 * reflow when the answer lands — a layout that jumps at the moment of arrival undoes the
 * work the loading state just did.
 */
export function ResultSkeleton() {
  return (
    <div className="flex animate-pulse items-start gap-4 rounded-xl border border-[hsl(var(--border))] p-5">
      <div className="h-24 w-24 shrink-0 rounded-lg bg-[hsl(var(--surface))]" />
      <div className="flex-1 space-y-2">
        <div className="h-4 w-2/5 rounded bg-[hsl(var(--surface))]" />
        <div className="h-3 w-3/5 rounded bg-[hsl(var(--surface))]" />
        <div className="h-3 w-1/4 rounded bg-[hsl(var(--surface))]" />
      </div>
      <div className="h-5 w-16 rounded bg-[hsl(var(--surface))]" />
    </div>
  );
}
