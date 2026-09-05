import { Logger } from '@aws-lambda-powertools/logger';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoRateLimiter, failOpen, type RateLimiter } from '@catalograil/aws';
import { HttpCatalog } from './catalog.js';
import { buildServer, type AuthContext } from './server.js';
import {
  TokenVerifier,
  authorizationServerMetadata,
  connectRequired,
  protectedResourceMetadata,
  registeredClient,
  requireScope,
  type OAuthConfig,
  type VerifiedCaller,
} from './oauth.js';
import { z } from 'zod';
import { SERVER_DESCRIPTION } from './tools.js';

const logger = new Logger({ serviceName: 'mcp' });

/**
 * T2.1 — the MCP server on Lambda, behind a Function URL.
 *
 * Streamable HTTP rather than SSE: a Lambda cannot hold an open stream across invocations,
 * and a transport that appears to work locally and stalls in deployment is worse than one
 * that never pretended.
 *
 * Requests to the catalogue are SigV4-signed with this Lambda's own role. `/internal/*` is
 * machine-to-machine and the MCP server is a machine, so it authenticates the way the
 * dashboards' preview does — no shared secret to distribute or rotate.
 */

const signer = new SignatureV4({
  service: 'execute-api',
  region: process.env.AWS_REGION ?? 'ap-south-1',
  credentials: fromNodeProviderChain(),
  sha256: Sha256,
});

async function signedFetch(url: string, init: RequestInit): Promise<Response> {
  const target = new URL(url);
  const signed = await signer.sign({
    method: init.method ?? 'POST',
    protocol: target.protocol,
    hostname: target.hostname,
    path: target.pathname,
    headers: { host: target.hostname, 'content-type': 'application/json' },
    body: init.body as string,
  });
  return fetch(url, { ...init, headers: signed.headers as Record<string, string> });
}

let cachedLimiter: RateLimiter | undefined;

/**
 * Wrapped in `failOpen`, so a DynamoDB problem degrades abuse protection rather than
 * taking the tools down. Refusing every call because we cannot count them punishes every
 * honest caller for a problem none of them caused.
 */
function limiter(): RateLimiter {
  if (!cachedLimiter) {
    cachedLimiter = failOpen(new DynamoRateLimiter(required('DDB_TABLE_RATE_LIMITS')), (err) =>
      // Loudly, because failing open silently means protection can be off for weeks with
      // every dashboard green and the only symptom a bill.
      logger.error('Rate limiter unavailable — allowing the request', {
        errorMessage: err instanceof Error ? err.message : String(err),
      }),
    );
  }
  return cachedLimiter;
}

/**
 * Who to count against.
 *
 * The MCP transport carries no session of ours, so the source IP is what there is. It is
 * imperfect — a whole office behind one NAT shares a bucket — which is why the limits are
 * generous enough that a human never reaches them and a script does immediately.
 */
function subjectFor(event: APIGatewayProxyEventV2): string {
  return event.requestContext.http.sourceIp || 'unknown';
}

let cachedVerifier: TokenVerifier | undefined;

/**
 * The server's own public URL, taken from the request rather than configured.
 *
 * The OAuth metadata has to advertise this endpoint as the protected resource, and a Lambda
 * cannot be told its own Function URL at deploy time — referencing it in the function's own
 * environment is a CloudFormation circular dependency, which is exactly what happened when
 * this was config. Reading the Host header is also simply more correct: it stays right if
 * the URL ever changes, and behind a custom domain later it reports the name the buyer
 * actually used.
 */
function oauth(event: APIGatewayProxyEventV2): {
  config: OAuthConfig;
  verifier: TokenVerifier;
} {
  const host = event.headers.host ?? event.headers.Host ?? '';
  const config: OAuthConfig = {
    issuer: required('COGNITO_ISSUER'),
    clientId: required('COGNITO_MCP_CLIENT_ID'),
    hostedUiDomain: required('COGNITO_HOSTED_UI'),
    resourceUrl: `https://${host}`,
  };
  // Only the verifier is cached: it holds the fetched JWKS, which is the expensive part.
  if (!cachedVerifier) cachedVerifier = new TokenVerifier(config);
  return { config, verifier: cachedVerifier };
}

function catalog(): HttpCatalog {
  return new HttpCatalog({
    apiBaseUrl: required('API_BASE_URL'),
    buyerAppUrl: required('BUYER_APP_URL'),
    signedFetch,
  });
}

/**
 * The JSON-RPC surface, handled directly rather than through the SDK's Node transport.
 *
 * The SDK's transports assume a long-lived server object bound to a request/response stream.
 * A Lambda gets one request and returns one response, so the adaptation is small and doing
 * it explicitly keeps the failure modes visible — an SDK transport half-working behind a
 * Function URL is a much harder thing to debug than this.
 */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const correlationId = event.requestContext.requestId;
  logger.appendKeys({ correlationId });
  // Held outside the try so a failure still answers the request it was answering. A client
  // matching responses to requests treats a null id as unmatched and waits.
  let requestId: string | number | null = null;

  try {
    const method = event.requestContext.http.method;

    /**
     * The discovery documents an assistant reads to start the OAuth flow (T2.7).
     *
     * Served from the MCP endpoint itself because that URL is the only one the buyer pasted
     * — everything else has to be reachable from it in one hop.
     */
    const path = event.rawPath.replace(/\/+$/, '');
    if (method === 'GET' && path.endsWith('/.well-known/oauth-protected-resource')) {
      return json(200, protectedResourceMetadata(oauth(event).config));
    }
    if (
      method === 'GET' &&
      (path.endsWith('/.well-known/oauth-authorization-server') ||
        path.endsWith('/.well-known/openid-configuration'))
    ) {
      return json(200, authorizationServerMetadata(oauth(event).config));
    }

    /**
     * Dynamic client registration (RFC 7591).
     *
     * Answered here rather than proxied, because Cognito has no such endpoint. Without it an
     * assistant has no client id, cannot start an authorization code flow, and adds the
     * connector as anonymous — which is exactly the "it never asked me to log in" report.
     */
    if (method === 'POST' && path.endsWith('/register')) {
      const registration = event.body
        ? (JSON.parse(
            event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body,
          ) as { redirect_uris?: unknown; client_name?: unknown })
        : null;
      return json(201, registeredClient(oauth(event).config, registration));
    }

    // A GET is how a connector probes for liveness before it will attempt a session.
    if (method === 'GET') {
      return json(200, {
        name: 'catalograil',
        version: '0.1.0',
        description: SERVER_DESCRIPTION,
        protocol: 'mcp',
      });
    }

    if (method !== 'POST') return json(405, rpcError(null, -32000, 'Method not allowed.'));

    const body = event.body
      ? (JSON.parse(
          event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body,
        ) as JsonRpcRequest)
      : null;

    if (!body || body.jsonrpc !== '2.0') {
      return json(400, rpcError(body?.id ?? null, -32600, 'Not a JSON-RPC 2.0 request.'));
    }

    requestId = body.id ?? null;

    /**
     * The challenge that makes a buyer see a login screen — on the personal tools only.
     *
     * An assistant starts OAuth when it is refused and never before, so *something* has to
     * refuse it. But refusing the handshake refuses everyone: searching is the thing a buyer
     * does before they have any reason to trust us with an account, and an assistant that
     * cannot answer "what shirts are under ₹2,500" without a sign-up is worth less than one
     * that can. So the line is drawn at the tools that read or act on someone's own data —
     * their addresses, their orders, an order placed in their name. Those are refused, the
     * connector starts the flow, and searching keeps working throughout.
     *
     * The tools also refuse themselves, in `requireToken`. This check is here because it can
     * refuse before the request costs anything, not because that one is redundant.
     */
    const authorizationHeader = event.headers.authorization ?? event.headers.Authorization;
    if (!authorizationHeader && body.method === 'tools/call') {
      const toolName = (body.params as { name?: string } | undefined)?.name ?? '';
      if (AUTHENTICATED_TOOLS.has(toolName)) {
        logger.info('Unauthenticated call to a personal tool', { tool: toolName });
        return unauthorized(event, requestId);
      }
    }

    /**
     * Throttled before the tool runs, not after.
     *
     * `create_checkout` is limited far more tightly than searching because it creates a
     * session and reserves nothing yet — but a script that can make ten thousand of them
     * fills the table and the queue behind it.
     */
    if (body.method === 'tools/call') {
      const toolName = (body.params as { name?: string } | undefined)?.name ?? '';
      const action = toolName === 'create_checkout' ? 'checkout' : 'search';
      const decision = await limiter().consume(subjectFor(event), action);

      if (!decision.allowed) {
        logger.info('Throttled', { action, subject: subjectFor(event) });
        return json(200, {
          jsonrpc: '2.0',
          id: body.id,
          result: {
            content: [
              {
                type: 'text',
                // A structured, quotable sentence rather than a bare code: the model has to
                // tell the buyer something, and given only a 429 it will invent a reason.
                text: JSON.stringify({
                  error: 'rate_limited',
                  retry_after_seconds: decision.retryAfterSeconds,
                  message: `Too many requests. Try again in ${decision.retryAfterSeconds} seconds.`,
                }),
              },
            ],
            isError: true,
          },
        });
      }
    }

    /**
     * The buyer's token, verified once per request and shared with the tools that need it.
     *
     * Only tool calls pay for it. The handshake is challenged on a missing header alone,
     * which costs nothing; a signature check and a JWKS fetch are worth doing once a caller
     * is about to act, and the scopes it yields only mean anything there.
     */
    let verified: VerifiedCaller | null | undefined;
    const authorization = authorizationHeader;

    const authContext: AuthContext = {
      token: () => (authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : null),
      requireScope: (scope) => {
        if (!verified) throw new Error('Token was not verified.');
        requireScope(verified, scope);
      },
    };

    if (authorization && body.method === 'tools/call') {
      // A malformed or expired token is an error the buyer can act on, not a silent
      // downgrade to anonymous — which would look like the assistant forgetting them.
      verified = await oauth(event).verifier.verify(authorization);
    }

    const result = await dispatch(body, authContext);
    // A notification has no id and expects no reply; returning one is a protocol error.
    if (result === undefined) return { statusCode: 202, body: '' };
    return json(200, { jsonrpc: '2.0', id: body.id, result });
  } catch (err) {
    logger.error('MCP request failed', {
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    /**
     * Errors come back as JSON-RPC errors with HTTP 200.
     *
     * A model handles a structured error by telling the buyer what went wrong; an HTTP 500
     * with an opaque body it handles by inventing an explanation, which is the failure mode
     * the whole hallucination audit exists to prevent.
     */
    /**
     * An unauthenticated tool call gets the "connect your account" payload, not a bare error.
     *
     * The MCP spec's 401 with `WWW-Authenticate` is what lets a connector start the flow
     * automatically; the structured tool result is what lets the model explain it to the
     * buyer if the connector does not.
     */
    if ((err as { code?: string }).code === 'UNAUTHENTICATED') {
      return unauthorized(event, requestId);
    }

    return json(200, rpcError(requestId, -32603, err instanceof Error ? err.message : 'Internal error.'));
  } finally {
    logger.removeKeys(['correlationId']);
  }
}

interface JsonRpcRequest {
  jsonrpc: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

async function dispatch(request: JsonRpcRequest, auth: AuthContext): Promise<unknown> {
  const server = buildServer(catalog(), auth);

  switch (request.method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'catalograil', version: '0.1.0' },
        instructions: SERVER_DESCRIPTION,
      };

    case 'notifications/initialized':
      return undefined;

    case 'tools/list':
      return { tools: listTools(server) };

    case 'tools/call': {
      const params = (request.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      if (!params.name) throw new Error('A tool name is required.');
      return callTool(server, params.name, params.arguments ?? {});
    }

    case 'ping':
      return {};

    default:
      throw new Error(`Unknown method: ${request.method}`);
  }
}

/** Reaches into the SDK's registry, which is where `server.tool()` records its definitions. */
function listTools(server: ReturnType<typeof buildServer>): unknown[] {
  const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;

  return Object.entries(registered).map(([name, tool]) => ({
    name,
    description: tool.description,
    inputSchema: toJsonSchema(tool.inputSchema),
  }));
}

async function callTool(
  server: ReturnType<typeof buildServer>,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const tool = registered[name];
  if (!tool) throw new Error(`Unknown tool: ${name}`);

  const parsed = tool.inputSchema ? tool.inputSchema.parse(args) : args;
  /**
   * `handler`, not `callback`.
   *
   * The SDK's registry key is not part of its public API and is not what the docs suggest —
   * it was found by inspecting a built server, and a deployed call failed with
   * "n.callback is not a function" until it was. Worth the note: an SDK upgrade can move it
   * again, and the symptom appears only at runtime.
   */
  return tool.handler(parsed, {});
}

interface RegisteredTool {
  description?: string;
  /** A Zod object with the raw shape still reachable, which is what `toJsonSchema` reads. */
  inputSchema?: { parse(input: unknown): unknown; shape?: Record<string, unknown> };
  handler(args: unknown, extra: unknown): Promise<unknown>;
}

/**
 * Zod to JSON Schema.
 *
 * This was hand-rolled against Zod 3's `_def.typeName`, which Zod 4 does not have. Every
 * field therefore fell through to `type: "string"` and none were marked optional — so the
 * tool list told Claude that ten string parameters were all required, and Claude did the
 * only thing it could: sent `"5"` for `limit`, `"true"` for `in_stock_only`, and `""` for
 * every optional it had nothing to say about. The connector looked broken. It was being
 * told the wrong shape.
 *
 * Zod ships its own converter now, so use it. `io: 'input'` matters — these schemas coerce
 * and default, and the model needs the shape it should *send*, not the shape a handler
 * receives. `required` is computed by asking each field whether it tolerates being absent,
 * which is the only definition that stays true through preprocess and pipe wrappers.
 */
export function toJsonSchema(schema?: RegisteredTool['inputSchema']): Record<string, unknown> {
  const shape = (schema as unknown as { shape?: Record<string, ZodField> })?.shape ?? {};
  const { $schema: _ignored, ...json } = z.toJSONSchema(z.object(shape as never), {
    io: 'input',
    unrepresentable: 'any',
  }) as Record<string, unknown>;

  const required = Object.entries(shape)
    .filter(([, field]) => !field.safeParse(undefined).success)
    .map(([key]) => key);

  return { ...json, type: 'object', ...(required.length > 0 ? { required } : {}) };
}

interface ZodField {
  safeParse(input: unknown): { success: boolean };
}

function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * The tools that need an account. Everything else — searching, comparing, reading a
 * merchant's policies, starting a checkout — answers anyone.
 */
const AUTHENTICATED_TOOLS = new Set([
  'get_my_addresses',
  'list_my_orders',
  'get_order_status',
  'place_order',
]);

/**
 * A 401 carrying both halves of the answer.
 *
 * The `WWW-Authenticate` header with `resource_metadata` is what a connector reads to start
 * the OAuth flow on its own; the JSON-RPC body is what a model reads if the connector does
 * not, so it can tell the buyer to connect their account instead of inventing a reason.
 *
 * A caveat worth knowing before debugging this from a `curl -i`: a Lambda Function URL
 * rewrites this header to `x-amzn-Remapped-www-authenticate` on the way out, so the client
 * never sees it under the name the spec names. Discovery still works, because a client that
 * gets a 401 falls back to fetching `/.well-known/oauth-protected-resource` from the server
 * URL it was given — which is served here, one hop from the URL the buyer pasted. The header
 * is sent anyway, for the day this sits behind something that does not rewrite it.
 */
function unauthorized(
  event: APIGatewayProxyEventV2,
  id: string | number | null,
): APIGatewayProxyResultV2 {
  const resource = publicUrl(event);
  return {
    statusCode: 401,
    headers: {
      'content-type': 'application/json',
      'www-authenticate': `Bearer resource_metadata="${resource}/.well-known/oauth-protected-resource"`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32001,
        message: 'Connect your Conciergent account to use this.',
        data: connectRequired(resource),
      },
    }),
  };
}

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function publicUrl(event: APIGatewayProxyEventV2): string {
  return `https://${event.headers.host ?? event.headers.Host ?? ''}`;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}
