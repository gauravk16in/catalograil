import { describe, expect, it } from 'vitest';
import { requireBuyer, requireMerchant, type AuthorizedEvent } from './index.js';

/**
 * These tests exist because the failure they guard against is silent and total: a handler
 * that resolves the wrong merchant does not error, it returns someone else's catalogue.
 */

function event(claims: Record<string, unknown> | null, extra: object = {}): AuthorizedEvent {
  return {
    requestContext: claims ? { authorizer: { jwt: { claims } } } : {},
    ...extra,
  } as AuthorizedEvent;
}

describe('requireMerchant', () => {
  it('reads the merchant id from the verified claims', () => {
    const caller = requireMerchant(
      event({ sub: 'cognito-sub-1', 'custom:merchant_id': 'merchant-1', email: 'a@b.com' }),
    );
    expect(caller).toEqual({ id: 'merchant-1', subject: 'cognito-sub-1', email: 'a@b.com' });
  });

  it('ignores a merchant id supplied in the request', () => {
    /**
     * The whole point. The old handler read `x-merchant-id` from the headers, so any
     * caller could act as any merchant by editing one value. Even with a valid token for
     * merchant-1, a header naming merchant-2 must have no effect whatsoever.
     */
    const caller = requireMerchant(
      event(
        { sub: 's', 'custom:merchant_id': 'merchant-1' },
        { headers: { 'x-merchant-id': 'merchant-2' }, body: '{"merchantId":"merchant-2"}' },
      ),
    );
    expect(caller.id).toBe('merchant-1');
  });

  it('fails closed when no authorizer ran', () => {
    // A route deployed without a JWT authorizer must not fall back to anything.
    expect(() => requireMerchant(event(null))).toThrow(/no verified identity/i);
  });

  it('rejects a token with no subject', () => {
    expect(() => requireMerchant(event({ 'custom:merchant_id': 'm1' }))).toThrow(/subject/i);
  });

  it('distinguishes an unlinked account from a missing session', () => {
    // Signing in again yields the same token, so the client must retry rather than log out.
    try {
      requireMerchant(event({ sub: 'brand-new-user' }));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as { code: string }).code).toBe('ACCOUNT_NOT_LINKED');
      expect((err as { httpStatus: number }).httpStatus).toBe(409);
      expect((err as { retryable: boolean }).retryable).toBe(true);
    }
  });

  it('does not accept a buyer claim as a merchant identity', () => {
    // Belt and braces: the pools are separate so this token would already be rejected by
    // the authorizer, but a merchant handler must never resolve a buyer either way.
    expect(() => requireMerchant(event({ sub: 's', 'custom:buyer_id': 'buyer-1' }))).toThrow();
  });

  it('treats an empty claim as absent rather than as an id', () => {
    // An empty string is falsy in SQL predicates in confusing ways; it must never become
    // a caller id.
    expect(() => requireMerchant(event({ sub: 's', 'custom:merchant_id': '' }))).toThrow();
  });
});

describe('requireBuyer', () => {
  it('reads the buyer id from the verified claims', () => {
    expect(requireBuyer(event({ sub: 's', 'custom:buyer_id': 'buyer-9' })).id).toBe('buyer-9');
  });

  it('does not accept a merchant claim as a buyer identity', () => {
    expect(() => requireBuyer(event({ sub: 's', 'custom:merchant_id': 'm1' }))).toThrow();
  });
});
