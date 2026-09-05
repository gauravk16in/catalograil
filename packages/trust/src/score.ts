/**
 * T2.11 — trust computation.
 *
 * The number that decides whose product a buyer sees first, so it is worth being precise
 * about what it can and cannot know. It is made of two very different things: verification,
 * which a merchant controls on day one, and performance, which takes real orders to earn.
 * Blending them without care lets a merchant buy their way to the top by filling in forms.
 */

/** Bayesian prior strength: how many "average" reviews a new merchant is treated as having. */
export const RATING_PRIOR_COUNT = 10;

/** Below this, a merchant has not earned a performance signal (§8's ten-order rule). */
export const ESTABLISHED_ORDER_THRESHOLD = 10;

/** The most a new merchant can score, however perfect their handful of orders looks. */
export const NEW_MERCHANT_CAP = 0.6;

/** Acknowledging within six hours is full marks; slower decays linearly to zero. */
export const RESPONSIVENESS_CEILING_MINUTES = 360;

export interface VerificationInputs {
  readonly gstinVerified: boolean;
  readonly razorpayAccountActive: boolean;
  readonly policiesValid: boolean;
  readonly businessAgeMonths: number;
}

export interface PerformanceInputs {
  readonly ordersTotal: number;
  readonly ordersFulfilled: number;
  readonly ordersCancelled: number;
  readonly onTimeDeliveries: number;
  readonly avgRating: number | null;
  readonly ratingCount: number;
  readonly avgAckMinutes: number | null;
  readonly disputeCount: number;
}

export interface TrustInputs extends VerificationInputs, PerformanceInputs {
  /** Mean rating across the platform, for the Bayesian prior. */
  readonly platformMeanRating: number;
}

export interface TrustResult {
  readonly verificationScore: number;
  readonly trustScore: number;
  readonly isNewMerchant: boolean;
  /** Each weighted component, for explaining a score rather than asserting it. */
  readonly components: Readonly<Record<string, number>>;
}

export function verificationScore(inputs: VerificationInputs): number {
  return round(
    (inputs.gstinVerified ? 0.3 : 0) +
      (inputs.razorpayAccountActive ? 0.25 : 0) +
      (inputs.policiesValid ? 0.25 : 0) +
      (inputs.businessAgeMonths >= 6 ? 0.2 : 0),
  );
}

/**
 * A rating pulled toward the platform mean by a prior of ten reviews.
 *
 * Without this a single five-star review outranks two hundred reviews averaging 4.6, which
 * is both wrong and trivially gamed. Returned on 0..1 rather than 1..5, because it is
 * summed with five other components that are already fractions — leaving it on the star
 * scale would give it roughly five times its intended weight, silently.
 */
export function bayesianRating(
  avgRating: number | null,
  ratingCount: number,
  platformMean: number,
): number {
  const mean = clamp(platformMean, 1, 5);
  if (avgRating == null || ratingCount <= 0) return normaliseStars(mean);

  const sum = clamp(avgRating, 1, 5) * ratingCount;
  const adjusted =
    (RATING_PRIOR_COUNT * mean + sum) / (RATING_PRIOR_COUNT + ratingCount);
  return normaliseStars(adjusted);
}

export function computeTrust(inputs: TrustInputs): TrustResult {
  const verification = verificationScore(inputs);

  /**
   * Fulfilment is measured against orders the merchant *accepted*, not every order ever
   * created. An order the buyer cancelled is not a merchant failure, and counting it as one
   * punishes merchants for their buyers changing their minds.
   */
  const accepted = Math.max(inputs.ordersTotal - inputs.ordersCancelled, 0);
  const fulfilmentRate = accepted > 0 ? clamp(inputs.ordersFulfilled / accepted, 0, 1) : 0;

  const onTimeRate =
    inputs.ordersFulfilled > 0
      ? clamp(inputs.onTimeDeliveries / inputs.ordersFulfilled, 0, 1)
      : 0;

  const rating = bayesianRating(inputs.avgRating, inputs.ratingCount, inputs.platformMeanRating);

  /**
   * An unmeasured acknowledgement time scores zero, not full marks.
   *
   * A merchant with no orders has no responsiveness to report, and defaulting to 1 would
   * hand them a component they have not earned — which is exactly how a brand new merchant
   * ends up outranking someone with a record.
   */
  const responsiveness =
    inputs.avgAckMinutes == null
      ? 0
      : clamp(1 - inputs.avgAckMinutes / RESPONSIVENESS_CEILING_MINUTES, 0, 1);

  const disputeRate = accepted > 0 ? clamp(inputs.disputeCount / accepted, 0, 1) : 0;

  const components = {
    verification: 0.25 * verification,
    fulfilment: 0.25 * fulfilmentRate,
    onTime: 0.2 * onTimeRate,
    rating: 0.15 * rating,
    responsiveness: 0.1 * responsiveness,
    disputes: 0.05 * (1 - disputeRate),
  };

  const raw = Object.values(components).reduce((sum, value) => sum + value, 0);

  /**
   * The cold-start cap, which is §8's rule made arithmetic: a merchant with fewer than ten
   * completed orders must not outrank an established one on trust alone.
   *
   * Capping at `min(verification, 0.60)` rather than at a flat 0.60 means an unverified new
   * merchant cannot reach even that — their ceiling is whatever they have actually proven.
   */
  const isNewMerchant = inputs.ordersTotal < ESTABLISHED_ORDER_THRESHOLD;
  const trustScore = isNewMerchant
    ? Math.min(raw, Math.min(verification, NEW_MERCHANT_CAP))
    : raw;

  return {
    verificationScore: verification,
    trustScore: round(clamp(trustScore, 0, 1)),
    isNewMerchant,
    components: Object.fromEntries(
      Object.entries(components).map(([key, value]) => [key, round(value)]),
    ),
  };
}

/** Stars (1..5) onto 0..1, so every component in the sum is on the same scale. */
function normaliseStars(stars: number): number {
  return clamp((stars - 1) / 4, 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Three decimals, matching `numeric(4,3)` in the schema. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
