import { describe, expect, it } from 'vitest';
import { groupByMerchant, issueHandoffToken, verifyHandoffToken } from './index.js';

const SECRET = 'a-test-signing-secret-not-a-real-one';

describe('handoff token', () => {
  it('round-trips a session id', () => {
    const issued = issueHandoffToken('sess-1', SECRET);
    expect(verifyHandoffToken(issued.token, SECRET).sessionId).toBe('sess-1');
  });

  it('rejects a token signed with a different secret', () => {
    const issued = issueHandoffToken('sess-1', SECRET);
    expect(() => verifyHandoffToken(issued.token, 'another-secret')).toThrow(/not valid/i);
  });

  it('rejects a tampered payload', () => {
    /**
     * The attack this exists to stop: swapping the session id in a URL to resume someone
     * else's cart, which carries their address and contact details.
     */
    const issued = issueHandoffToken('sess-1', SECRET);
    const [, signature] = issued.token.split('.');
    const forged = `${Buffer.from('sess-2.99999999999.x', 'utf8').toString('base64url')}.${signature}`;
    expect(() => verifyHandoffToken(forged, SECRET)).toThrow(/not valid/i);
  });

  it('rejects a malformed token without throwing something unhelpful', () => {
    for (const bad of ['', 'nodot', 'a.b.c.d.e', '....']) {
      expect(() => verifyHandoffToken(bad, SECRET)).toThrow();
    }
  });

  it('distinguishes an expired link from an invalid one', () => {
    /**
     * Expiry is not an error the buyer caused. Someone who left a chat open over lunch
     * should be invited back, not told they did something wrong — so the page can show
     * "start again" only because the code says which it was.
     */
    const issued = issueHandoffToken('sess-1', SECRET, new Date('2026-09-05T10:00:00Z'));
    try {
      verifyHandoffToken(issued.token, SECRET, new Date('2026-09-05T10:20:00Z'));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as { code: string }).code).toBe('HANDOFF_TOKEN_EXPIRED');
    }
  });

  it('is still valid a minute before expiry', () => {
    const issued = issueHandoffToken('sess-1', SECRET, new Date('2026-09-05T10:00:00Z'));
    expect(
      verifyHandoffToken(issued.token, SECRET, new Date('2026-09-05T10:14:00Z')).sessionId,
    ).toBe('sess-1');
  });

  it('issues distinct tokens for the same session in the same second', () => {
    // Otherwise consuming one would silently consume the other.
    const now = new Date('2026-09-05T10:00:00Z');
    expect(issueHandoffToken('sess-1', SECRET, now).token).not.toBe(
      issueHandoffToken('sess-1', SECRET, now).token,
    );
  });

  it('is URL-safe, because it travels in one', () => {
    const { token } = issueHandoffToken('sess-1', SECRET);
    expect(token).toMatch(/^[A-Za-z0-9_.-]+$/);
    expect(encodeURIComponent(token)).toBe(token);
  });
});

describe('groupByMerchant', () => {
  it('groups a cart so each merchant can be paid on their own account', () => {
    const cart = [
      { productId: 'p1', quantity: 1, merchantId: 'm1', priceSnapshot: '100' },
      { productId: 'p2', quantity: 2, merchantId: 'm2', priceSnapshot: '200' },
      { productId: 'p3', quantity: 1, merchantId: 'm1', priceSnapshot: '300' },
    ];
    const groups = groupByMerchant(cart);
    expect(groups.size).toBe(2);
    expect(groups.get('m1')).toHaveLength(2);
  });
});
