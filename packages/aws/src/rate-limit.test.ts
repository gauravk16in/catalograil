import { describe, expect, it } from 'vitest';
import { InMemoryRateLimiter, RATE_LIMITS, failOpen } from './rate-limit.js';

describe('rate limiting', () => {
  it('allows the configured number of searches and throttles the next', async () => {
    // T2.8's acceptance: the 31st search in a minute is throttled.
    const limiter = new InMemoryRateLimiter();
    for (let i = 0; i < RATE_LIMITS.search!.limit; i++) {
      expect((await limiter.consume('ip-1', 'search')).allowed).toBe(true);
    }
    const throttled = await limiter.consume('ip-1', 'search');
    expect(throttled.allowed).toBe(false);
    // A caller told to back off needs to know for how long, or it retries immediately.
    expect(throttled.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('counts each subject separately', async () => {
    const limiter = new InMemoryRateLimiter();
    for (let i = 0; i < RATE_LIMITS.search!.limit; i++) await limiter.consume('ip-1', 'search');
    expect((await limiter.consume('ip-2', 'search')).allowed).toBe(true);
  });

  it('counts each action separately, because they cost very different amounts', async () => {
    const limiter = new InMemoryRateLimiter();
    for (let i = 0; i < RATE_LIMITS.search!.limit; i++) await limiter.consume('ip-1', 'search');
    expect((await limiter.consume('ip-1', 'checkout')).allowed).toBe(true);
  });

  it('reports how many remain, so a caller can pace itself', async () => {
    const limiter = new InMemoryRateLimiter();
    const first = await limiter.consume('ip-3', 'search');
    expect(first.remaining).toBe(RATE_LIMITS.search!.limit - 1);
  });

  it('fails open when the limiter itself is broken', async () => {
    /**
     * A DynamoDB outage should degrade abuse protection, not take the product down with it.
     * Refusing every request because we cannot count them punishes every honest caller for
     * a problem none of them caused.
     */
    const broken = { consume: async () => { throw new Error('DynamoDB is unreachable.'); } };
    const result = await failOpen(broken).consume('ip-4', 'search');
    expect(result.allowed).toBe(true);
  });

  it('reports the failure rather than hiding it', async () => {
    // Failing open silently means protection can be off for weeks with every dashboard
    // green and the only symptom a bill.
    const seen: unknown[] = [];
    const broken = { consume: async () => { throw new Error('table gone'); } };
    await failOpen(broken, (err) => seen.push(err)).consume('ip-5', 'search');
    expect(seen).toHaveLength(1);
  });
});
