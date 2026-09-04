import { formatPaise, type SearchFiltersInput } from '@catalograil/core';

/**
 * The two sentences the calling model is allowed to repeat as fact (T1.19).
 *
 * Both are templated from signals that actually fired. Neither is generated, and that is
 * the entire point: an LLM downstream will quote these verbatim to a buyer, so a sentence
 * that sounds plausible but is not checkable would be a hallucination laundered through
 * our own API. There is also no LLM call in this path at all (rule 10) — these run in
 * microseconds, on data already in hand.
 */

/** What the hydrated row needs to expose for an explanation to be built. */
export interface ExplainableUnit {
  readonly attributes: Record<string, unknown>;
  readonly useCases?: string[] | null;
  readonly deliveryDays?: number | null;
  readonly pricePaise?: bigint | null;
  readonly inStock: boolean;
}

const MAX_CLAUSES = 3;

/**
 * Builds "why this matched" from the channels that fired and the filters that were met.
 *
 * Ordered by what a buyer actually asked for: an attribute they named beats a use case we
 * inferred, which beats a delivery promise, which beats price. Capped at three clauses,
 * because a sentence listing every reason reads like an excuse rather than an answer.
 */
export function buildWhyThisMatched(
  matchedChannels: readonly string[],
  unit: ExplainableUnit,
  filters: SearchFiltersInput,
): string {
  const clauses: string[] = [];

  // An attribute the buyer asked for by name, echoed back with its value.
  if (filters.attributes) {
    for (const [key, wanted] of Object.entries(filters.attributes)) {
      const actual = unit.attributes[key];
      if (actual !== undefined && String(actual).toLowerCase() === String(wanted).toLowerCase()) {
        clauses.push(`${humanise(key)} ${actual}`);
      }
    }
  }

  // A use case, but only when the intent channel is what found it — otherwise the listing
  // merely happens to mention it, which is not a reason.
  if (clauses.length < MAX_CLAUSES && matchedChannels.includes('intent') && unit.useCases?.length) {
    clauses.push(`suited to ${unit.useCases[0]}`);
  }

  if (clauses.length < MAX_CLAUSES && typeof unit.deliveryDays === 'number') {
    if (filters.maxDeliveryDays != null) {
      clauses.push(
        `arrives in ${formatDays(unit.deliveryDays)}, inside your ${formatDays(filters.maxDeliveryDays)}`,
      );
    } else if (unit.deliveryDays <= 2) {
      clauses.push(`arrives in ${formatDays(unit.deliveryDays)}`);
    }
  }

  if (clauses.length < MAX_CLAUSES && filters.maxPriceInr != null && unit.pricePaise != null) {
    clauses.push(`${formatPaise(unit.pricePaise)}, under your budget`);
  }

  // Nothing specific fired, so say the honest general thing rather than inventing a reason.
  if (clauses.length === 0) {
    if (matchedChannels.length === 1 && matchedChannels[0] === 'lexical') {
      return 'Matches the words you searched for';
    }
    return 'Close match for what you described';
  }

  return capitalise(clauses.slice(0, MAX_CLAUSES).join(', '));
}

/**
 * Explains an empty result set (rule 8).
 *
 * Named in order of how likely each is to be the binding constraint, so the sentence
 * points at the filter worth relaxing first rather than listing everything that was set.
 * Without this the calling model is left to guess, and a guess about why nothing was found
 * is exactly the kind of confident invention this whole design is trying to avoid.
 */
export function buildNoResultsReason(
  filters: SearchFiltersInput,
  query: string | undefined,
  context: { anyBeforeFilters: boolean },
): string {
  const constraints: string[] = [];

  if (filters.maxPriceInr != null)
    constraints.push(`under ₹${filters.maxPriceInr.toLocaleString('en-IN')}`);
  if (filters.minPriceInr != null)
    constraints.push(`over ₹${filters.minPriceInr.toLocaleString('en-IN')}`);
  if (filters.maxDeliveryDays != null)
    constraints.push(`delivered within ${formatDays(filters.maxDeliveryDays)}`);
  if (filters.inStockOnly) constraints.push('currently in stock');
  if (filters.categorySlug) constraints.push(`in ${humanise(filters.categorySlug)}`);
  if (filters.attributes) {
    for (const [key, value] of Object.entries(filters.attributes)) {
      constraints.push(`${humanise(key)} ${value}`);
    }
  }

  const subject = query ? `"${query}"` : 'that image';

  if (constraints.length === 0) {
    return `No listed products match ${subject}.`;
  }

  // The distinction that makes this actionable: is the query wrong, or the filters?
  if (!context.anyBeforeFilters) {
    return `No listed products match ${subject}.`;
  }

  return `No products matching ${subject} are ${joinWithAnd(constraints)}. Relaxing one of those may help.`;
}

function humanise(value: string): string {
  return value.replace(/[_-]+/g, ' ').trim();
}

function formatDays(days: number): string {
  return days === 1 ? '1 day' : `${days} days`;
}

function joinWithAnd(values: string[]): string {
  if (values.length === 1) return values[0]!;
  return `${values.slice(0, -1).join(', ')} and ${values.at(-1)}`;
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
