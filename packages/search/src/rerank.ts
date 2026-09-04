import { NEW_MERCHANT_TRUST_MULTIPLIER, RERANK_WEIGHTS } from '@catalograil/core';

/**
 * T1.18 — business re-rank.
 *
 * The fusion score from T1.17 answers "how well does this match the words". It does not
 * answer "should a buyer see this first". This stage adds the three things that decide
 * that: whether the merchant can be trusted, whether it arrives soon, and whether the
 * listing is still being maintained.
 *
 *   final = 0.55·normalise(fusion)
 *         + 0.20·trust
 *         + 0.15·deliverySpeed
 *         + 0.10·freshness
 *
 * Pure, and the clock is injected — freshness would otherwise make the tests
 * non-deterministic and the function untestable at a fixed point in time.
 *
 * Worth being clear about what this stage is NOT for. Hard constraints are SQL WHERE
 * exclusions upstream (rule 5). Nothing here is allowed to resurrect an item that cannot
 * arrive in time or is out of stock — by the time a candidate reaches this function, it
 * has already earned the right to be ranked.
 */

/** Delivery is at full marks up to this, then decays linearly. */
const DELIVERY_FAST_DAYS = 2;
/** Delivery scores zero at and beyond this. */
const DELIVERY_SLOW_DAYS = 10;

/** Freshness is at full marks below this age. */
const FRESHNESS_FULL_HOURS = 24;
/** Freshness reaches its floor at this age and stays there. */
const FRESHNESS_FLOOR_DAYS = 30;
/**
 * A listing untouched for a month still scores this much. The floor is deliberate: a
 * dashcam that has not been edited in a year is not thereby a worse dashcam, so staleness
 * shades a result down rather than burying it.
 */
const FRESHNESS_FLOOR = 0.3;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface RerankCandidate {
  readonly id: string;
  /** Reciprocal-rank-fusion score from the hybrid query. Unbounded, hence normalised. */
  readonly fusionScore: number;
  /** From `merchant_metrics.trust_score`, 0..1. Null for a merchant not yet scored. */
  readonly trustScore: number | null;
  /** Caps the trust contribution — never-do #3. */
  readonly isNewMerchant: boolean;
  /** Null for LIVE_PRICED and QUOTE, where no delivery promise exists. */
  readonly deliveryDays: number | null;
  /** `searchable_units.updated_at`. */
  readonly updatedAt: Date;
}

export interface RerankComponents {
  readonly fusion: number;
  readonly trust: number;
  readonly deliverySpeed: number;
  readonly freshness: number;
}

export interface RerankedResult<T extends RerankCandidate = RerankCandidate> {
  readonly candidate: T;
  readonly finalScore: number;
  /** Weighted contributions, summing to `finalScore`. Rendered by "why this matched". */
  readonly components: RerankComponents;
  /** True when the new-merchant cap actually reduced this result's trust contribution. */
  readonly newMerchantCapped: boolean;
}

export interface RerankOptions {
  /** Injected for determinism. Defaults to now. */
  readonly now?: Date;
}

/**
 * Scores and sorts candidates, highest first.
 *
 * Fusion is normalised against the best candidate in the set, not min-max across it. That
 * choice matters more than it looks — see `buildFusionNormaliser`. The consequence worth
 * knowing either way: a candidate's final score is only meaningful within one result set,
 * and must never be stored or compared across queries.
 */
export function rerank<T extends RerankCandidate>(
  candidates: readonly T[],
  options: RerankOptions = {},
): RerankedResult<T>[] {
  const now = options.now ?? new Date();
  const normalise = buildFusionNormaliser(candidates.map((c) => c.fusionScore));

  return candidates
    .map((candidate) => score(candidate, normalise, now))
    .sort((a, b) => b.finalScore - a.finalScore || compareIds(a.candidate.id, b.candidate.id));
}

function score<T extends RerankCandidate>(
  candidate: T,
  normalise: (value: number) => number,
  now: Date,
): RerankedResult<T> {
  const rawTrust = clamp01(candidate.trustScore ?? 0);
  const capped = candidate.isNewMerchant && rawTrust > 0;
  const effectiveTrust = candidate.isNewMerchant
    ? rawTrust * NEW_MERCHANT_TRUST_MULTIPLIER
    : rawTrust;

  const components: RerankComponents = {
    fusion: RERANK_WEIGHTS.fusion * normalise(candidate.fusionScore),
    trust: RERANK_WEIGHTS.trust * effectiveTrust,
    deliverySpeed: RERANK_WEIGHTS.deliverySpeed * deliverySpeedScore(candidate.deliveryDays),
    freshness: RERANK_WEIGHTS.freshness * freshnessScore(candidate.updatedAt, now),
  };

  return {
    candidate,
    finalScore:
      components.fusion + components.trust + components.deliverySpeed + components.freshness,
    components,
    newMerchantCapped: capped,
  };
}

/**
 * Divides by the best score in the set.
 *
 * Min-max is the obvious choice here and it is wrong. It pins the worst candidate to
 * exactly 0 however well it actually matched, so on a small result set a hair's-breadth
 * fusion difference is stretched to the full 0.55 weight: two candidates scoring 0.62 and
 * 0.58 come out as 0.55 and 0.00, and fusion then swamps every other signal. The
 * acceptance case for this task — a fast item beating a marginally better-matching slow
 * one — cannot hold under min-max at all.
 *
 * RRF scores are strictly positive and have a meaningful zero: an item matched by nothing
 * scores nothing. Dividing by the max keeps those ratios intact, so 0.58 against 0.62
 * stays the small difference it really is.
 *
 * When every candidate ties, they all get 1.0 and the other three signals decide the
 * order. When nothing matched at all, they all get 0 for the same reason.
 */
function buildFusionNormaliser(scores: readonly number[]): (value: number) => number {
  if (scores.length === 0) return () => 0;

  const max = Math.max(...scores);
  if (!Number.isFinite(max) || max <= 0) return () => 0;

  return (value) => clamp01(value / max);
}

/**
 * 1.0 at two days or fewer, falling linearly to 0 at ten.
 *
 * An unknown delivery time scores 0 rather than something neutral. A merchant who has not
 * committed to a delivery window has not earned the points for one, and scoring the
 * absence of a promise as average would make omitting the column the cheapest way to rank.
 * Note this only shades the ranking — a delivery *constraint* from the buyer is a SQL
 * exclusion upstream, so an item that genuinely cannot arrive in time is already gone.
 */
export function deliverySpeedScore(deliveryDays: number | null | undefined): number {
  if (deliveryDays === null || deliveryDays === undefined || !Number.isFinite(deliveryDays)) {
    return 0;
  }
  if (deliveryDays <= DELIVERY_FAST_DAYS) return 1;
  if (deliveryDays >= DELIVERY_SLOW_DAYS) return 0;
  return (DELIVERY_SLOW_DAYS - deliveryDays) / (DELIVERY_SLOW_DAYS - DELIVERY_FAST_DAYS);
}

/**
 * 1.0 under 24 hours old, decaying linearly to FRESHNESS_FLOOR at 30 days and holding
 * there. A future timestamp — clock skew between a writer and a reader — is treated as
 * fresh rather than allowed to produce a score above 1.
 */
export function freshnessScore(updatedAt: Date, now: Date = new Date()): number {
  const ageMs = now.getTime() - updatedAt.getTime();
  if (!Number.isFinite(ageMs) || ageMs <= FRESHNESS_FULL_HOURS * HOUR_MS) return 1;

  const floorMs = FRESHNESS_FLOOR_DAYS * DAY_MS;
  if (ageMs >= floorMs) return FRESHNESS_FLOOR;

  const decayProgress =
    (ageMs - FRESHNESS_FULL_HOURS * HOUR_MS) / (floorMs - FRESHNESS_FULL_HOURS * HOUR_MS);
  return 1 - (1 - FRESHNESS_FLOOR) * decayProgress;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Stable tie-break, so equal scores do not reorder between identical queries. */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
