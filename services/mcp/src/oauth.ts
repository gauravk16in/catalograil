import { AppError } from '@catalograil/core';

/**
 * T2.7 — OAuth 2.1 for the MCP server, delegated to Cognito.
 *
 * The MCP authorization spec asks a server to advertise *where* to authenticate rather than
 * to be the place. That is the right shape here: Cognito already issues, refreshes, revokes
 * and consents, and a hand-rolled authorization server would mean owning the parts of the
 * flow whose entire value is in being correct.
 *
 * So this module does two small things — publish the discovery documents, and verify the
 * bearer token an assistant presents — and delegates everything else.
 */

/** Everything an assistant may be granted. Listed once: the two metadata documents and the
 * registration response must agree, and they drift the moment they are written out twice. */
const SCOPES = [
  'openid',
  'email',
  'catalograil/addresses.read',
  'catalograil/orders.read',
  'catalograil/orders.write',
] as const;

export interface OAuthConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly hostedUiDomain: string;
  /** The buyer dashboard, which hosts the page the authorization flow starts on. */
  readonly buyerAppUrl: string;
  /** The MCP endpoint's own URL, which is the "resource" being protected. */
  readonly resourceUrl: string;
}

/**
 * `/.well-known/oauth-protected-resource`.
 *
 * An assistant that gets a 401 from a tool reads this to learn which authorization server to
 * send the buyer to. Without it the connector can only report a failure, and the buyer sees
 * "something went wrong" rather than a login prompt.
 */
export function protectedResourceMetadata(config: OAuthConfig): Record<string, unknown> {
  return {
    resource: config.resourceUrl,
    authorization_servers: [config.issuer],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ['header'],
  };
}

/**
 * `/.well-known/oauth-authorization-server`, mirrored from Cognito.
 *
 * Cognito publishes its own OpenID discovery document, but at a path some clients do not
 * look for and with an `authorization_endpoint` on the hosted UI domain rather than the
 * issuer. Mirroring it here means an assistant finds everything it needs in one hop from
 * the MCP URL the buyer pasted, which is the only URL they have.
 */
export function authorizationServerMetadata(config: OAuthConfig): Record<string, unknown> {
  const ui = config.hostedUiDomain.replace(/\/$/, '');
  return {
    issuer: config.issuer,
    /**
     * Conciergent's own page, which explains the request and then hands off to Cognito.
     *
     * Pointing this straight at the hosted UI sent buyers to an unfamiliar domain with an
     * unexplained login box, moments before granting software permission to order in their
     * name — the exact shape of a phishing page. The page passes every parameter through
     * untouched; only the first screen changes.
     */
    authorization_endpoint: `${config.buyerAppUrl.replace(/\/$/, '')}/authorize`,
    token_endpoint: `${ui}/oauth2/token`,
    userinfo_endpoint: `${ui}/oauth2/userInfo`,
    revocation_endpoint: `${ui}/oauth2/revoke`,
    jwks_uri: `${config.issuer}/.well-known/jwks.json`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    // PKCE with S256 only. `plain` is still in the spec and offers no protection against
    // the interception this whole exchange exists to prevent.
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    /**
     * Dynamic client registration, which Cognito does not do and Claude will not connect
     * without. See `registeredClient` — the endpoint is ours and hands back the one app
     * client that already exists.
     */
    registration_endpoint: `${config.resourceUrl.replace(/\/$/, '')}/register`,
    scopes_supported: [...SCOPES],
  };
}

/**
 * `POST /register` — RFC 7591, answered with a client that was registered long ago.
 *
 * Claude and ChatGPT will not start an OAuth flow against a server whose metadata has no
 * `registration_endpoint`: they have no client id and no way to ask for one, so the connector
 * is added with no authentication at all and every personal tool fails. Cognito has no
 * dynamic registration to proxy to, and its app client cannot accept a redirect URI it was
 * not deployed with anyway.
 *
 * So this returns the existing public PKCE client and echoes back the redirect URIs the
 * caller asked for. That is not a security hole being papered over: the redirect URIs Cognito
 * will actually honour are fixed in the user pool, so a caller that asks for its own is
 * refused at the authorize step regardless of what this says here.
 */
export function registeredClient(
  config: OAuthConfig,
  request: { redirect_uris?: unknown; client_name?: unknown } | null,
): Record<string, unknown> {
  const redirectUris = Array.isArray(request?.redirect_uris) ? request.redirect_uris : [];
  return {
    client_id: config.clientId,
    // No secret: this is a public client and the flow is PKCE. Issuing one would imply a
    // confidential client and invite a caller to send it where it does not belong.
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: redirectUris,
    ...(typeof request?.client_name === 'string' ? { client_name: request.client_name } : {}),
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: SCOPES.join(' '),
  };
}

export interface VerifiedCaller {
  readonly subject: string;
  readonly scopes: readonly string[];
  readonly email?: string;
}

/**
 * Verifies a Cognito access token and returns who it belongs to.
 *
 * Signature verification is done against Cognito's published JWKS. The keys are cached for
 * the life of the Lambda container: they rotate rarely, and fetching them on every tool call
 * would add a network round trip inside a latency budget measured in a model's pause.
 */
export class TokenVerifier {
  private keys: Map<string, CryptoKey> | null = null;

  constructor(private readonly config: OAuthConfig) {}

  async verify(authorization: string | undefined): Promise<VerifiedCaller> {
    if (!authorization?.startsWith('Bearer ')) {
      throw new AppError('UNAUTHENTICATED', 'This tool needs you to connect your account.');
    }

    const token = authorization.slice(7).trim();
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new AppError('UNAUTHENTICATED', 'That access token is not a JWT.');
    }

    const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString()) as { kid?: string };
    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()) as {
      sub?: string;
      iss?: string;
      exp?: number;
      scope?: string;
      token_use?: string;
      email?: string;
      client_id?: string;
    };

    const key = await this.keyFor(header.kid);
    const valid = await crypto.subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5' },
      key,
      Buffer.from(parts[2]!, 'base64url'),
      Buffer.from(`${parts[0]}.${parts[1]}`),
    );
    if (!valid) throw new AppError('UNAUTHENTICATED', 'That access token failed verification.');

    /**
     * Issuer, expiry and token use are all checked.
     *
     * `token_use` matters more than it looks: a Cognito *id* token is signed by the same
     * keys and would otherwise verify happily, while carrying none of the scopes that decide
     * what an assistant may do.
     */
    if (claims.iss !== this.config.issuer) {
      throw new AppError('UNAUTHENTICATED', 'That token was issued by someone else.');
    }
    if (claims.token_use !== 'access') {
      throw new AppError('UNAUTHENTICATED', 'That is not an access token.');
    }
    if (!claims.exp || claims.exp * 1000 <= Date.now()) {
      throw new AppError('UNAUTHENTICATED', 'Your connection has expired. Reconnect your account.');
    }
    if (!claims.sub) throw new AppError('UNAUTHENTICATED', 'That token has no subject.');

    return {
      subject: claims.sub,
      scopes: claims.scope ? claims.scope.split(' ') : [],
      ...(claims.email ? { email: claims.email } : {}),
    };
  }

  private async keyFor(kid: string | undefined): Promise<CryptoKey> {
    if (!kid) throw new AppError('UNAUTHENTICATED', 'That token names no signing key.');

    if (!this.keys) {
      const response = await fetch(`${this.config.issuer}/.well-known/jwks.json`);
      if (!response.ok) {
        throw new AppError('INTERNAL_ERROR', 'Could not fetch the signing keys.');
      }
      const jwks = (await response.json()) as { keys: JsonWebKey[] & { kid: string }[] };
      this.keys = new Map();
      for (const jwk of jwks.keys) {
        this.keys.set(
          jwk.kid,
          await crypto.subtle.importKey(
            'jwk',
            jwk,
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
            false,
            ['verify'],
          ),
        );
      }
    }

    const key = this.keys.get(kid);
    if (!key) throw new AppError('UNAUTHENTICATED', 'That token was signed by an unknown key.');
    return key;
  }
}

/**
 * The error an unauthenticated tool returns.
 *
 * A structured payload rather than a bare 401, because the model has to say something useful
 * to the buyer. Given only a status code it invents an explanation; given this, it can say
 * "you need to connect your Conciergent account" and point at the right place.
 */
export function connectRequired(resourceUrl: string): Record<string, unknown> {
  return {
    error: 'authentication_required',
    message:
      'Connect your Conciergent account to use this. You will be asked to sign in and to ' +
      'approve what this assistant may do — see your addresses, see your orders, and place ' +
      'orders on your behalf.',
    resource_metadata: `${resourceUrl.replace(/\/$/, '')}/.well-known/oauth-protected-resource`,
  };
}

/** Refuses a tool call whose token lacks the scope it needs. */
export function requireScope(caller: VerifiedCaller, scope: string): void {
  if (!caller.scopes.includes(scope)) {
    throw new AppError(
      'FORBIDDEN',
      `Your assistant was not granted permission to ${describeScope(scope)}. ` +
        'Reconnect your account and approve it.',
    );
  }
}

function describeScope(scope: string): string {
  if (scope.endsWith('addresses.read')) return 'see your saved addresses';
  if (scope.endsWith('orders.read')) return 'see your orders';
  if (scope.endsWith('orders.write')) return 'place orders for you';
  return scope;
}
