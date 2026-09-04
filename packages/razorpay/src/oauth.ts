import { randomUUID } from 'node:crypto';
import { AppError } from '@catalograil/core';

/**
 * T1.6 — the Razorpay OAuth flow.
 *
 * The merchant authorises us against *their* Razorpay account, and every payment object is
 * later created with the token this produces (D4). We never hold funds; the merchant is the
 * merchant of record. That makes this exchange the single most security-sensitive path in
 * the system, and the reason `state` is enforced rather than merely generated.
 */

export interface OAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly revokeUrl: string;
  readonly scopes: string[];
}

export function oauthConfigFromEnv(): OAuthConfig {
  return {
    clientId: required('RAZORPAY_CLIENT_ID'),
    clientSecret: required('RAZORPAY_CLIENT_SECRET'),
    redirectUri: required('RAZORPAY_OAUTH_REDIRECT_URI'),
    authorizeUrl: process.env.RAZORPAY_OAUTH_AUTHORIZE_URL ?? 'https://auth.razorpay.com/authorize',
    tokenUrl: process.env.RAZORPAY_OAUTH_TOKEN_URL ?? 'https://auth.razorpay.com/token',
    revokeUrl: process.env.RAZORPAY_OAUTH_REVOKE_URL ?? 'https://auth.razorpay.com/revoke',
    scopes: (process.env.RAZORPAY_OAUTH_SCOPES ?? 'read_write').split(/[,\s]+/).filter(Boolean),
  };
}

/**
 * Short-lived, single-use `state` records.
 *
 * Backed by DynamoDB with a 10-minute TTL in production. The single-use property is what
 * matters and it is the store's job: `consume` must return a value at most once, or a
 * replayed callback could bind an attacker's Razorpay account to a merchant's session.
 */
export interface OAuthStateStore {
  /** Stores the state and whatever the callback will need to continue. */
  put(state: string, payload: OAuthStatePayload, ttlSeconds: number): Promise<void>;
  /** Returns the payload and deletes it atomically. A second call must return undefined. */
  consume(state: string): Promise<OAuthStatePayload | undefined>;
}

export interface OAuthStatePayload {
  readonly createdAt: string;
  /** Where to send the merchant once the exchange completes. */
  readonly returnTo?: string;
}

const STATE_TTL_SECONDS = 10 * 60;

export interface AuthorizeRedirect {
  readonly url: string;
  readonly state: string;
}

/**
 * Step one: mint a `state`, remember it, and build the URL to send the merchant to.
 */
export async function buildAuthorizeRedirect(
  config: OAuthConfig,
  store: OAuthStateStore,
  options: { returnTo?: string } = {},
): Promise<AuthorizeRedirect> {
  const state = randomUUID();

  await store.put(
    state,
    {
      createdAt: new Date().toISOString(),
      ...(options.returnTo ? { returnTo: options.returnTo } : {}),
    },
    STATE_TTL_SECONDS,
  );

  const url = new URL(config.authorizeUrl);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', config.scopes.join(' '));
  url.searchParams.set('state', state);

  return { url: url.toString(), state };
}

export interface TokenResponse {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessExpiresAt: Date;
  readonly refreshExpiresAt: Date;
  readonly scopes: string[];
  /** Razorpay's account identifier for the merchant, e.g. `acc_...`. */
  readonly razorpayAccountId?: string;
}

/** Refresh tokens are long-lived; Razorpay does not always state an expiry, so assume a year. */
const DEFAULT_REFRESH_TTL_SECONDS = 365 * 24 * 60 * 60;

/**
 * Step two: validate `state`, then exchange the code for tokens.
 *
 * The state check comes first and is fatal. An unknown or already-used state means the
 * callback did not originate from a redirect we issued, and continuing would exchange a
 * code we have no reason to trust.
 */
export async function exchangeAuthorizationCode(
  config: OAuthConfig,
  store: OAuthStateStore,
  params: { code: string; state: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ tokens: TokenResponse; payload: OAuthStatePayload }> {
  const payload = await store.consume(params.state);
  if (!payload) {
    throw new AppError(
      'INVALID_OAUTH_STATE',
      'This authorisation link has expired or was already used.',
      {
        retryable: false,
      },
    );
  }

  const response = await fetchImpl(config.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'authorization_code',
      redirect_uri: config.redirectUri,
      code: params.code,
      mode: process.env.STAGE === 'prod' ? 'live' : 'test',
    }),
  });

  if (!response.ok) {
    // The body can contain the client secret we just sent back; it is not logged.
    throw new AppError(
      'OAUTH_EXCHANGE_FAILED',
      `Razorpay rejected the authorisation code (${response.status}).`,
      {
        retryable: response.status >= 500,
      },
    );
  }

  return { tokens: parseTokenResponse(await response.json()), payload };
}

/** T1.7 — swap a refresh token for a new access token. */
export async function refreshAccessToken(
  config: OAuthConfig,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> {
  const response = await fetchImpl(config.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    throw new AppError(
      'MERCHANT_TOKEN_EXPIRED',
      `Razorpay refused the refresh (${response.status}).`,
      {
        // A 4xx means the merchant revoked us and no amount of retrying will help; a 5xx is
        // Razorpay's problem and worth trying again.
        retryable: response.status >= 500,
        details: { status: response.status },
      },
    );
  }

  return parseTokenResponse(await response.json());
}

export async function revokeToken(
  config: OAuthConfig,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(config.revokeUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      token,
      token_type_hint: 'access_token',
    }),
  });

  // A token Razorpay already considers dead is the outcome we wanted.
  if (!response.ok && response.status !== 400 && response.status !== 404) {
    throw new AppError('OAUTH_EXCHANGE_FAILED', `Could not revoke the token (${response.status}).`);
  }
}

export function parseTokenResponse(body: unknown): TokenResponse {
  const data = (body ?? {}) as Record<string, unknown>;
  const accessToken = typeof data.access_token === 'string' ? data.access_token : '';
  const refreshToken = typeof data.refresh_token === 'string' ? data.refresh_token : '';

  if (!accessToken || !refreshToken) {
    throw new AppError('OAUTH_EXCHANGE_FAILED', 'Razorpay did not return both tokens.');
  }

  const expiresIn = Number(data.expires_in ?? 0);
  const now = Date.now();

  return {
    accessToken,
    refreshToken,
    // `expires_in` is seconds from now, so the absolute time has to be computed here —
    // storing the relative value would make the refresh worker's scan meaningless.
    accessExpiresAt: new Date(
      now + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000,
    ),
    refreshExpiresAt: new Date(now + DEFAULT_REFRESH_TTL_SECONDS * 1000),
    scopes: typeof data.scope === 'string' ? data.scope.split(/[,\s]+/).filter(Boolean) : [],
    ...(typeof data.razorpay_account_id === 'string'
      ? { razorpayAccountId: data.razorpay_account_id }
      : {}),
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new AppError('DEPENDENCY_UNAVAILABLE', `Missing env var ${name}`);
  }
  return value;
}
