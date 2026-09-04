import { AppError } from '../errors/index.js';

/**
 * S2.3 — the caller's identity comes from the token, never from the request.
 *
 * This is the most important rule in the auth layer, and it is a helper rather than a
 * convention because a convention only has to be forgotten once. The merchant API
 * previously read `x-merchant-id` from the headers: any caller past the gateway could act
 * as any merchant by editing one value. That is horizontal privilege escalation, and the
 * only thing preventing it was IAM authorization keeping browsers out entirely — which is
 * also why the dashboards did not work.
 *
 * API Gateway validates the JWT's signature, issuer, audience and expiry before the Lambda
 * runs, and puts the verified claims in the request context. A claim read here has already
 * been checked; this module's job is to make reading it the path of least resistance, and
 * to make the alternative unreachable by accident.
 */

/** The shape an HTTP API JWT authorizer puts on the event. */
export interface JwtAuthorizerContext {
  readonly jwt?: {
    readonly claims?: Record<string, unknown>;
    readonly scopes?: string[];
  };
}

export interface AuthorizedEvent {
  readonly requestContext: {
    readonly authorizer?: JwtAuthorizerContext;
  };
}

export interface Caller {
  /** Our own id for the principal — `merchants.id` or `buyers.id`. */
  readonly id: string;
  /** Cognito's `sub`: stable for the life of the user, never reused. */
  readonly subject: string;
  readonly email?: string;
}

/**
 * The merchant making this request.
 *
 * Throws rather than returning null. Every caller is a handler that cannot proceed without
 * an identity, and a null flowing onward becomes a query scoped to `undefined` — which in
 * the wrong query shape means "every merchant".
 */
export function requireMerchant(event: AuthorizedEvent): Caller {
  return requireCaller(event, 'custom:merchant_id', 'merchant');
}

export function requireBuyer(event: AuthorizedEvent): Caller {
  return requireCaller(event, 'custom:buyer_id', 'buyer');
}

function requireCaller(
  event: AuthorizedEvent,
  idClaim: string,
  kind: 'merchant' | 'buyer',
): Caller {
  const claims = event.requestContext.authorizer?.jwt?.claims;

  if (!claims) {
    /**
     * No authorizer context means the route was reached without a JWT authorizer attached.
     * That is a deployment mistake, and it fails closed rather than falling back to a
     * header — a fallback is exactly how the `x-merchant-id` vulnerability would return,
     * and it would return silently.
     */
    throw new AppError('UNAUTHENTICATED', 'This request carries no verified identity.');
  }

  const subject = asString(claims.sub);
  if (!subject) throw new AppError('UNAUTHENTICATED', 'Token has no subject.');

  const id = asString(claims[idClaim]);
  if (!id) {
    // A confirmed user whose post-confirmation trigger has not linked them yet. Distinct
    // from "not signed in": signing in again produces the same token, so the client must
    // retry rather than bounce to the login screen.
    throw new AppError(
      'ACCOUNT_NOT_LINKED',
      `This account is not linked to a ${kind} yet. If you have just signed up, try again in a moment.`,
      { retryable: true },
    );
  }

  const email = asString(claims.email);
  return { id, subject, ...(email ? { email } : {}) };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
