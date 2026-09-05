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

export interface OAuthConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly hostedUiDomain: string;
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
    scopes_supported: [
      'openid',
      'email',
      'catalograil/addresses.read',
      'catalograil/orders.read',
      'catalograil/orders.write',
    ],
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
    authorization_endpoint: `${ui}/oauth2/authorize`,
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
    scopes_supported: [
      'openid',
      'email',
      'catalograil/addresses.read',
      'catalograil/orders.read',
      'catalograil/orders.write',
    ],
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
