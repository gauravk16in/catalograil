import { createHash } from 'node:crypto';
import type { Archetype } from '@catalograil/core';

/**
 * T1.14 — composes the text that gets embedded, and the hash that decides whether to
 * re-embed at all.
 *
 * Pure by construction: no I/O, no clock, no randomness. That is not stylistic. Rule 9
 * makes `contentHash` the gate on every Bedrock call, so this function's output has to be
 * reproducible from its input alone, or the cost control silently stops working.
 *
 * Two properties the tests pin down, because both cost real money if they break:
 *   - Reordering `attributes` keys must not change the hash.
 *   - Changing a price or a stock count must not change the hash.
 */

/** Max attribute pairs in the canonical text, per the T1.14 template. */
const MAX_ATTRIBUTES = 10;

/** Description budget, per the T1.14 template. */
const DESCRIPTION_TOKEN_BUDGET = 400;

/**
 * Characters per token, used to approximate the budget above.
 *
 * An exact count would mean shipping a tokenizer — a large dependency, and one that
 * belongs to whichever model MODELS.md (T1.2) settles on. This is a deliberate
 * approximation: 4 characters per token is the conventional English estimate, and
 * erring long only costs a few tokens on an embedding call that is already batched.
 * If descriptions start getting clipped mid-thought, raise the budget rather than
 * reaching for a tokenizer.
 */
const CHARS_PER_TOKEN = 4;

export interface CanonicalUnitInput {
  readonly archetype: Archetype;
  readonly name: string;
  readonly brand?: string | null;
  /** ltree path, e.g. `apparel.shirts`. Rendered with separators the model can read. */
  readonly categoryPath?: string | null;
  readonly description?: string | null;
  /** Product-level attributes: fabric, wattage, warranty_days. */
  readonly attributes?: Readonly<Record<string, unknown>> | null;
  /**
   * This variant's own point on each axis, e.g. `{"size":"42","colour":"lilac"}`.
   *
   * These are merged into the attribute line and take precedence over product
   * attributes on a key collision. Without them every variant of a product would
   * compose identical text, hash identically, and collapse to one embedding — which
   * would make variant-level semantic retrieval impossible, and D6 says the variant
   * is the searchable unit. The T1.14 template does not spell this out; it follows
   * from D6.
   */
  readonly optionValues?: Readonly<Record<string, string>> | null;
  readonly useCases?: readonly string[] | null;
  readonly targetAudience?: readonly string[] | null;
  readonly occasions?: readonly string[] | null;
  /** All axes the parent product is sold along. VARIANT only. */
  readonly optionAxes?: readonly { name: string; values: readonly string[] }[] | null;
  /** LIVE_PRICED only. */
  readonly routeOrScope?: string | null;
  /** Free text like "₹2,000–4,000". LIVE_PRICED and QUOTE. */
  readonly priceRangeHint?: string | null;
  readonly deliveryDays?: number | null;
}

/**
 * Builds the canonical text. Empty lines are omitted rather than left blank, so a
 * sparse product does not embed a column of dangling labels.
 */
export function composeCanonicalText(input: CanonicalUnitInput): string {
  const lines: (string | undefined)[] = [
    headline(input.name, input.brand),
    formatCategoryPath(input.categoryPath),
    formatAttributes(input.attributes, input.optionValues),
    truncateToApproxTokens(clean(input.description), DESCRIPTION_TOKEN_BUDGET),
    labelledList('Used for', input.useCases),
    labelledList('Suited to', input.targetAudience),
    labelledList('Occasions', input.occasions),
    input.archetype === 'VARIANT' ? formatOptionAxes(input.optionAxes) : undefined,
    input.archetype === 'LIVE_PRICED' ? labelled('Route/scope', input.routeOrScope) : undefined,
    formatAvailability(input.priceRangeHint, input.deliveryDays),
  ];

  return lines
    .filter((line): line is string => typeof line === 'string' && line.length > 0)
    .join('\n');
}

/**
 * sha256 of the canonical text. Compared against the stored `content_hash` before any
 * embedding call; equal means update the denormalised filterables and stop (T1.15).
 */
export function contentHash(canonicalText: string): string {
  return createHash('sha256').update(canonicalText, 'utf8').digest('hex');
}

/** Compose and hash in one step — what the embedding worker actually calls. */
export function composeCanonical(input: CanonicalUnitInput): {
  canonicalText: string;
  contentHash: string;
} {
  const canonicalText = composeCanonicalText(input);
  return { canonicalText, contentHash: contentHash(canonicalText) };
}

// ─── Line builders ────────────────────────────────────────────────────────────────

function headline(name: string, brand?: string | null): string {
  const cleanName = clean(name);
  const cleanBrand = clean(brand);
  return cleanBrand ? `${cleanName} — ${cleanBrand}` : cleanName;
}

/** `apparel.shirts.formal` reads better to a language model as `apparel > shirts > formal`. */
function formatCategoryPath(path?: string | null): string | undefined {
  const value = clean(path);
  if (!value) return undefined;
  return value.split('.').map(humanise).join(' > ');
}

/**
 * `k: v` pairs, sorted by key, capped at MAX_ATTRIBUTES.
 *
 * Sorting is what makes the hash independent of key order — the enrichment worker
 * returns JSON whose key order is not guaranteed stable between runs, and without this
 * every re-enrichment would look like a content change and pay for a fresh embedding.
 *
 * Option values are selected ahead of product attributes when the cap bites, since they
 * are what distinguishes one unit from its siblings.
 */
function formatAttributes(
  attributes?: Readonly<Record<string, unknown>> | null,
  optionValues?: Readonly<Record<string, string>> | null,
): string | undefined {
  const options = normaliseEntries(optionValues);
  const product = normaliseEntries(attributes).filter(([key]) => !hasKey(options, key));

  const selected = [...options.sort(byKey), ...product.sort(byKey)].slice(0, MAX_ATTRIBUTES);
  if (selected.length === 0) return undefined;

  return selected
    .sort(byKey)
    .map(([key, value]) => `${humanise(key)}: ${value}`)
    .join(', ');
}

function formatOptionAxes(
  axes?: readonly { name: string; values: readonly string[] }[] | null,
): string | undefined {
  if (!axes || axes.length === 0) return undefined;

  const rendered = axes
    .map((axis) => {
      const name = clean(axis.name);
      const values = axis.values.map(clean).filter(Boolean);
      return name && values.length > 0 ? `${humanise(name)} ${values.join('/')}` : undefined;
    })
    .filter((part): part is string => Boolean(part));

  return rendered.length > 0 ? `Available in: ${rendered.join('; ')}` : undefined;
}

/**
 * The T1.14 template's last line is `Typically: {price_range_hint}, delivered in
 * {delivery_days} days`. Either half can be absent — a SIMPLE product has no price hint,
 * a QUOTE has no delivery estimate — so the halves are assembled independently rather
 * than emitting "Typically: , delivered in null days".
 *
 * Note what is NOT here: `price_paise`. An exact price must never reach the canonical
 * text, or every repricing would trigger a re-embed and rule 9 would be dead on arrival.
 */
function formatAvailability(
  priceRangeHint?: string | null,
  deliveryDays?: number | null,
): string | undefined {
  const parts: string[] = [];

  const hint = clean(priceRangeHint);
  if (hint) parts.push(hint);

  if (typeof deliveryDays === 'number' && Number.isFinite(deliveryDays) && deliveryDays >= 0) {
    parts.push(deliveryDays === 1 ? 'delivered in 1 day' : `delivered in ${deliveryDays} days`);
  }

  return parts.length > 0 ? `Typically: ${parts.join(', ')}` : undefined;
}

function labelledList(label: string, values?: readonly string[] | null): string | undefined {
  if (!values || values.length === 0) return undefined;
  const cleaned = dedupe(values.map(clean).filter(Boolean));
  return cleaned.length > 0 ? `${label}: ${cleaned.join(', ')}` : undefined;
}

function labelled(label: string, value?: string | null): string | undefined {
  const cleaned = clean(value);
  return cleaned ? `${label}: ${cleaned}` : undefined;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────────

/**
 * Collapses whitespace and trims. Without this, a description pasted from a CSV with a
 * trailing newline hashes differently from the same description typed in the dashboard.
 */
function clean(value?: string | null): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function humanise(key: string): string {
  return key.replace(/[_-]+/g, ' ').trim();
}

function byKey(a: [string, string], b: [string, string]): number {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

function hasKey(entries: [string, string][], key: string): boolean {
  return entries.some(([k]) => k === key);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Attribute values arrive as anything JSON can hold. Each is rendered deterministically:
 * an object's keys are sorted so `{a:1,b:2}` and `{b:2,a:1}` produce the same string,
 * for the same reason the top-level keys are sorted.
 */
function normaliseEntries(source?: Readonly<Record<string, unknown>> | null): [string, string][] {
  if (!source) return [];

  const entries: [string, string][] = [];
  for (const [key, raw] of Object.entries(source)) {
    const cleanKey = clean(key);
    if (!cleanKey) continue;
    const value = stringifyValue(raw);
    if (value) entries.push([cleanKey, value]);
  }
  return entries;
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return clean(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) {
    return value.map(stringifyValue).filter(Boolean).join('/');
  }
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => [clean(k), stringifyValue(v)] as const)
      .filter(([k, v]) => k && v)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([k, v]) => `${humanise(k)} ${v}`)
      .join(' ');
  }
  return '';
}

/**
 * Truncates to roughly `maxTokens`, on a word boundary so the text never ends mid-word.
 * See CHARS_PER_TOKEN on why this is an estimate rather than a real token count.
 */
export function truncateToApproxTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return text;

  const clipped = text.slice(0, maxChars);
  const lastSpace = clipped.lastIndexOf(' ');
  return (lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped).trimEnd();
}
