import { describe, expect, it } from 'vitest';
import { bayesianRating, buildTrustSignals, computeTrust, verificationScore } from './index.js';

const PLATFORM_MEAN = 4.2;

/** A fully verified merchant with a real track record. */
const ESTABLISHED = {
  gstinVerified: true,
  razorpayAccountActive: true,
  policiesValid: true,
  businessAgeMonths: 24,
  ordersTotal: 400,
  ordersFulfilled: 380,
  ordersCancelled: 10,
  onTimeDeliveries: 357,
  avgRating: 4.6,
  ratingCount: 212,
  avgAckMinutes: 45,
  disputeCount: 4,
  platformMeanRating: PLATFORM_MEAN,
};

describe('verificationScore', () => {
  it('is the sum of the four weights when everything is verified', () => {
    expect(verificationScore(ESTABLISHED)).toBe(1);
  });

  it('gives nothing for a business under six months', () => {
    // The one component that cannot be earned by filling in a form.
    expect(verificationScore({ ...ESTABLISHED, businessAgeMonths: 5 })).toBe(0.8);
  });

  it('is zero for a merchant who has verified nothing', () => {
    expect(
      verificationScore({
        gstinVerified: false,
        razorpayAccountActive: false,
        policiesValid: false,
        businessAgeMonths: 0,
      }),
    ).toBe(0);
  });
});

describe('bayesianRating', () => {
  it('pulls a lone five-star review most of the way back to the mean', () => {
    /**
     * (10·4.2 + 5) / 11 = 4.27 stars, which is 0.818 on 0..1 — not the 1.0 a raw average
     * would give. One review outranking two hundred is both wrong and trivially gamed.
     */
    expect(bayesianRating(5, 1, PLATFORM_MEAN)).toBeCloseTo((47 / 11 - 1) / 4, 3);
  });

  it('barely moves a rating backed by hundreds of reviews', () => {
    const withPrior = bayesianRating(4.6, 212, PLATFORM_MEAN);
    expect(withPrior).toBeCloseTo((4.582 - 1) / 4, 2);
  });

  it('returns the platform mean when there are no ratings at all', () => {
    expect(bayesianRating(null, 0, PLATFORM_MEAN)).toBeCloseTo((PLATFORM_MEAN - 1) / 4, 5);
  });

  it('is normalised to 0..1, not left on the star scale', () => {
    // Left on 1..5 it would carry roughly five times its intended weight in the sum.
    expect(bayesianRating(5, 1000, PLATFORM_MEAN)).toBeLessThanOrEqual(1);
  });
});

describe('computeTrust', () => {
  it('matches the score calculated by hand', () => {
    /**
     * verification    1.000 × 0.25 = 0.2500
     * fulfilment  380/390 = 0.9744 × 0.25 = 0.2436
     * onTime      357/380 = 0.9395 × 0.20 = 0.1879
     * rating      (10·4.2+975.2)/222 = 4.5820 → 0.8955 × 0.15 = 0.1343
     * responsive  1 − 45/360 = 0.8750 × 0.10 = 0.0875
     * disputes    1 − 4/390 = 0.9897 × 0.05 = 0.0495
     *                                        ─────────
     *                                          0.9528
     */
    const result = computeTrust(ESTABLISHED);
    expect(result.verificationScore).toBe(1);
    expect(result.isNewMerchant).toBe(false);
    expect(result.trustScore).toBeCloseTo(0.953, 2);
  });

  it('measures fulfilment against accepted orders, not every order created', () => {
    // A buyer cancelling is not a merchant failure, and counting it as one punishes a
    // merchant for their buyers changing their minds.
    const noCancellations = computeTrust({ ...ESTABLISHED, ordersCancelled: 0, ordersTotal: 390 });
    expect(noCancellations.components.fulfilment).toBeCloseTo(
      computeTrust(ESTABLISHED).components.fulfilment!,
      3,
    );
  });

  it('caps a new merchant however perfect their handful of orders looks', () => {
    /**
     * §8's rule made arithmetic. Three orders, all fulfilled, all on time, five stars —
     * a raw score near 0.95, which must not beat an established merchant.
     */
    const newcomer = computeTrust({
      ...ESTABLISHED,
      ordersTotal: 3,
      ordersFulfilled: 3,
      ordersCancelled: 0,
      onTimeDeliveries: 3,
      avgRating: 5,
      ratingCount: 3,
    });

    expect(newcomer.isNewMerchant).toBe(true);
    expect(newcomer.trustScore).toBeLessThanOrEqual(0.6);
    // The acceptance criterion, stated directly.
    expect(newcomer.trustScore).toBeLessThan(computeTrust(ESTABLISHED).trustScore);
  });

  it('caps an unverified newcomer below the flat new-merchant ceiling', () => {
    // Their ceiling is what they have proven, not a number everyone gets for free.
    const unverified = computeTrust({
      ...ESTABLISHED,
      gstinVerified: false,
      policiesValid: false,
      businessAgeMonths: 0,
      ordersTotal: 2,
      ordersFulfilled: 2,
      ordersCancelled: 0,
      onTimeDeliveries: 2,
      ratingCount: 2,
    });
    expect(unverified.trustScore).toBeLessThanOrEqual(0.25);
  });

  it('does not hand an unmeasured acknowledgement time full marks', () => {
    const unmeasured = computeTrust({ ...ESTABLISHED, avgAckMinutes: null });
    expect(unmeasured.components.responsiveness).toBe(0);
  });

  it('stays within 0 and 1 for a merchant with nothing at all', () => {
    const empty = computeTrust({
      gstinVerified: false,
      razorpayAccountActive: false,
      policiesValid: false,
      businessAgeMonths: 0,
      ordersTotal: 0,
      ordersFulfilled: 0,
      ordersCancelled: 0,
      onTimeDeliveries: 0,
      avgRating: null,
      ratingCount: 0,
      avgAckMinutes: null,
      disputeCount: 0,
      platformMeanRating: PLATFORM_MEAN,
    });
    expect(empty.trustScore).toBe(0);
    expect(empty.isNewMerchant).toBe(true);
  });
});

describe('buildTrustSignals', () => {
  it('reads honestly for a brand new merchant', () => {
    /**
     * The acceptance criterion. A reader skims the shape of a list before its contents, so
     * a four-item list reads as a track record whatever the items say.
     */
    const trust = computeTrust({
      ...ESTABLISHED,
      ordersTotal: 0,
      ordersFulfilled: 0,
      ordersCancelled: 0,
      onTimeDeliveries: 0,
      avgRating: null,
      ratingCount: 0,
      avgAckMinutes: null,
    });

    const signals = buildTrustSignals({
      ...ESTABLISHED,
      ordersTotal: 0,
      ordersFulfilled: 0,
      ordersCancelled: 0,
      onTimeDeliveries: 0,
      avgRating: null,
      ratingCount: 0,
      avgAckMinutes: null,
      trust,
    });

    expect(signals).toContain('New on the platform');
    expect(signals.join(' ')).not.toMatch(/0 orders?/);
    expect(signals.join(' ')).not.toMatch(/on time/);
    expect(signals.join(' ')).not.toMatch(/★/);
  });

  it('states a real track record in full', () => {
    const signals = buildTrustSignals({ ...ESTABLISHED, trust: computeTrust(ESTABLISHED) });
    expect(signals).toEqual([
      'GSTIN verified',
      '380 orders fulfilled',
      '94% delivered on time',
      '4.6★ from 212 buyers',
      'Usually acknowledges within an hour',
      'Selling for 2 years',
    ]);
  });

  it('says nothing about on-time delivery when the rate is poor', () => {
    // Below half is a warning, not a signal, and dressing it up would be worse than silence.
    const signals = buildTrustSignals({
      ...ESTABLISHED,
      onTimeDeliveries: 100,
      trust: computeTrust({ ...ESTABLISHED, onTimeDeliveries: 100 }),
    });
    expect(signals.join(' ')).not.toMatch(/delivered on time/);
  });
});
