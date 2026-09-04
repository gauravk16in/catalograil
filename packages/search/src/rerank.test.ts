import { RERANK_WEIGHTS } from '@catalograil/core';
import { describe, expect, it } from 'vitest';
import { deliverySpeedScore, freshnessScore, rerank, type RerankCandidate } from './rerank.js';

const NOW = new Date('2026-09-04T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 60 * 60 * 1000);
const daysAgo = (d: number) => hoursAgo(d * 24);

function candidate(overrides: Partial<RerankCandidate> & { id: string }): RerankCandidate {
  return {
    fusionScore: 0.5,
    trustScore: 0.8,
    isNewMerchant: false,
    deliveryDays: 3,
    updatedAt: hoursAgo(2),
    ...overrides,
  };
}

// ─── Acceptance criteria ──────────────────────────────────────────────────────────

describe('a cheap slow item does not outrank a slightly pricier fast one', () => {
  /**
   * Price is deliberately absent from the re-rank formula — it is a filter, not a score
   * (rule 5). So the scenario plays out through the delivery term: the cheap item is the
   * slow one, and it arrives with a marginally *better* fusion score, which is the case
   * where a naive ranker would put it first.
   */
  const results = rerank(
    [
      candidate({ id: 'cheap-slow', fusionScore: 0.62, deliveryDays: 9 }),
      candidate({ id: 'pricier-fast', fusionScore: 0.58, deliveryDays: 2 }),
    ],
    { now: NOW },
  );

  it('puts the fast one first', () => {
    expect(results[0]?.candidate.id).toBe('pricier-fast');
  });

  it('and the delivery term is what did it', () => {
    const fast = results.find((r) => r.candidate.id === 'pricier-fast')!;
    const slow = results.find((r) => r.candidate.id === 'cheap-slow')!;

    // The slow item genuinely won the text match…
    expect(slow.components.fusion).toBeGreaterThan(fast.components.fusion);
    // …and still lost, because delivery more than made up the difference.
    expect(fast.components.deliverySpeed).toBeGreaterThan(slow.components.deliverySpeed);
    expect(fast.finalScore).toBeGreaterThan(slow.finalScore);
  });
});

describe('a 3-order merchant does not top a 400-order merchant on trust alone', () => {
  /**
   * Never-do #3. The new merchant is given a *perfect* trust score and the established one
   * a merely good score, with everything else held equal — the strongest form of the case.
   */
  const results = rerank(
    [
      candidate({ id: 'new-merchant', trustScore: 1.0, isNewMerchant: true }),
      candidate({ id: 'established', trustScore: 0.87, isNewMerchant: false }),
    ],
    { now: NOW },
  );

  it('ranks the established merchant first', () => {
    expect(results[0]?.candidate.id).toBe('established');
  });

  it('marks the capped result so the surface can say why', () => {
    const fresh = results.find((r) => r.candidate.id === 'new-merchant')!;
    expect(fresh.newMerchantCapped).toBe(true);
    expect(results.find((r) => r.candidate.id === 'established')?.newMerchantCapped).toBe(false);
  });

  it('caps the contribution at 0.6x rather than zeroing it', () => {
    const fresh = results.find((r) => r.candidate.id === 'new-merchant')!;
    // 0.20 weight × 1.0 trust × 0.6 cap
    expect(fresh.components.trust).toBeCloseTo(0.2 * 1.0 * 0.6, 10);
    expect(fresh.components.trust).toBeGreaterThan(0);
  });

  it('still lets a new merchant win on a decisively better match', () => {
    // The cap must not make a new merchant unrankable — only unable to win on trust alone.
    const strong = rerank(
      [
        candidate({ id: 'new-merchant', fusionScore: 1.0, trustScore: 1.0, isNewMerchant: true }),
        candidate({ id: 'established', fusionScore: 0.1, trustScore: 0.87 }),
      ],
      { now: NOW },
    );
    expect(strong[0]?.candidate.id).toBe('new-merchant');
  });
});

// ─── Scoring components ───────────────────────────────────────────────────────────

describe('weights', () => {
  it('sum to 1', () => {
    const total = Object.values(RERANK_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it('components sum to the final score', () => {
    const [result] = rerank([candidate({ id: 'a' })], { now: NOW });
    const { fusion, trust, deliverySpeed, freshness } = result!.components;
    expect(fusion + trust + deliverySpeed + freshness).toBeCloseTo(result!.finalScore, 10);
  });

  it('a perfect candidate scores 1', () => {
    const [result] = rerank(
      [candidate({ id: 'a', fusionScore: 1, trustScore: 1, deliveryDays: 1, updatedAt: NOW })],
      { now: NOW },
    );
    expect(result!.finalScore).toBeCloseTo(1, 10);
  });
});

describe('deliverySpeedScore', () => {
  it('is full marks at two days or fewer', () => {
    expect(deliverySpeedScore(0)).toBe(1);
    expect(deliverySpeedScore(1)).toBe(1);
    expect(deliverySpeedScore(2)).toBe(1);
  });

  it('decays linearly to zero at ten days', () => {
    expect(deliverySpeedScore(6)).toBeCloseTo(0.5, 10);
    expect(deliverySpeedScore(10)).toBe(0);
    expect(deliverySpeedScore(30)).toBe(0);
  });

  it('scores an unknown delivery time at zero, not neutral', () => {
    // Otherwise omitting the column becomes the cheapest way to rank.
    expect(deliverySpeedScore(null)).toBe(0);
    expect(deliverySpeedScore(undefined)).toBe(0);
  });
});

describe('freshnessScore', () => {
  it('is full marks under 24 hours', () => {
    expect(freshnessScore(NOW, NOW)).toBe(1);
    expect(freshnessScore(hoursAgo(23), NOW)).toBe(1);
  });

  it('decays to the floor at 30 days and holds there', () => {
    expect(freshnessScore(daysAgo(30), NOW)).toBeCloseTo(0.3, 10);
    expect(freshnessScore(daysAgo(365), NOW)).toBeCloseTo(0.3, 10);
  });

  it('decays monotonically in between', () => {
    const ages = [1, 5, 10, 20, 29].map((d) => freshnessScore(daysAgo(d), NOW));
    for (let i = 1; i < ages.length; i++) {
      expect(ages[i]!).toBeLessThan(ages[i - 1]!);
    }
    expect(ages[0]).toBeLessThanOrEqual(1);
    expect(ages.at(-1)!).toBeGreaterThan(0.3);
  });

  it('treats a future timestamp as fresh rather than scoring above 1', () => {
    // Clock skew between the writer and the reader must not produce a score over 1.
    expect(freshnessScore(new Date(NOW.getTime() + 60_000), NOW)).toBe(1);
  });
});

// ─── Normalisation ────────────────────────────────────────────────────────────────

describe('fusion normalisation', () => {
  it('scores each candidate as its share of the best one', () => {
    const results = rerank(
      [
        candidate({ id: 'low', fusionScore: 0.1 }),
        candidate({ id: 'mid', fusionScore: 0.5 }),
        candidate({ id: 'high', fusionScore: 1.0 }),
      ],
      { now: NOW },
    );
    const byId = new Map(results.map((r) => [r.candidate.id, r.components.fusion]));
    expect(byId.get('high')).toBeCloseTo(RERANK_WEIGHTS.fusion, 10);
    expect(byId.get('mid')).toBeCloseTo(RERANK_WEIGHTS.fusion * 0.5, 10);
    // The worst candidate keeps the credit it earned instead of being pinned to zero.
    expect(byId.get('low')).toBeCloseTo(RERANK_WEIGHTS.fusion * 0.1, 10);
    expect(byId.get('low')).toBeGreaterThan(0);
  });

  it('does not stretch a small fusion gap into a large one', () => {
    // The min-max pathology this normaliser exists to avoid.
    const results = rerank(
      [candidate({ id: 'a', fusionScore: 0.62 }), candidate({ id: 'b', fusionScore: 0.58 })],
      { now: NOW },
    );
    const gap = Math.abs(results[0]!.components.fusion - results[1]!.components.fusion);
    expect(gap).toBeLessThan(0.05);
  });

  it('gives everything zero fusion when nothing matched', () => {
    const results = rerank(
      [candidate({ id: 'a', fusionScore: 0 }), candidate({ id: 'b', fusionScore: 0 })],
      { now: NOW },
    );
    expect(results.every((r) => r.components.fusion === 0)).toBe(true);
  });

  it('gives every candidate full fusion marks when they all tie', () => {
    // The other three signals then decide, rather than an arbitrary tie-break.
    const results = rerank(
      [
        candidate({ id: 'slow', fusionScore: 0.4, deliveryDays: 9 }),
        candidate({ id: 'fast', fusionScore: 0.4, deliveryDays: 1 }),
      ],
      { now: NOW },
    );
    expect(results[0]?.candidate.id).toBe('fast');
    expect(results[0]?.components.fusion).toBeCloseTo(RERANK_WEIGHTS.fusion, 10);
  });

  it('handles a single candidate', () => {
    const results = rerank([candidate({ id: 'only', fusionScore: 42 })], { now: NOW });
    expect(results).toHaveLength(1);
    expect(results[0]?.components.fusion).toBeCloseTo(RERANK_WEIGHTS.fusion, 10);
  });

  it('handles an empty set', () => {
    expect(rerank([], { now: NOW })).toEqual([]);
  });
});

// ─── Robustness ───────────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('treats an unscored merchant as zero trust rather than failing', () => {
    const [result] = rerank([candidate({ id: 'a', trustScore: null })], { now: NOW });
    expect(result!.components.trust).toBe(0);
    expect(result!.newMerchantCapped).toBe(false);
  });

  it('clamps a trust score outside 0..1', () => {
    const results = rerank(
      [candidate({ id: 'over', trustScore: 5 }), candidate({ id: 'under', trustScore: -2 })],
      { now: NOW },
    );
    const byId = new Map(results.map((r) => [r.candidate.id, r.components.trust]));
    expect(byId.get('over')).toBeCloseTo(RERANK_WEIGHTS.trust, 10);
    expect(byId.get('under')).toBe(0);
  });

  it('orders identically across repeated calls', () => {
    const set = [
      candidate({ id: 'b', fusionScore: 0.5 }),
      candidate({ id: 'a', fusionScore: 0.5 }),
      candidate({ id: 'c', fusionScore: 0.5 }),
    ];
    const first = rerank(set, { now: NOW }).map((r) => r.candidate.id);
    const second = rerank([...set].reverse(), { now: NOW }).map((r) => r.candidate.id);
    expect(second).toEqual(first);
  });

  it('does not mutate the input', () => {
    const input = [candidate({ id: 'a' }), candidate({ id: 'b' })];
    const snapshot = JSON.stringify(input);
    rerank(input, { now: NOW });
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('preserves extra fields on the candidate for hydration downstream', () => {
    const results = rerank([{ ...candidate({ id: 'a' }), name: 'RoadEye 4K Dashcam' }], {
      now: NOW,
    });
    expect(results[0]?.candidate.name).toBe('RoadEye 4K Dashcam');
  });
});
