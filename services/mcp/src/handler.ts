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
  requireScope,
  type OAuthConfig,
  type VerifiedCaller,
} from './oauth.js';
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
     * Verification is lazy: the read-only tools work without any account at all, and making
     * every anonymous search pay a JWKS fetch and a signature check would be a real cost for
     * a check most calls do not need.
     */
    let verified: VerifiedCaller | null | undefined;
    const authorization = event.headers.authorization ?? event.headers.Authorization;

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
      return {
        statusCode: 401,
        headers: {
          'content-type': 'application/json',
          'www-authenticate': `Bearer resource_metadata="${publicUrl(event)}/.well-known/oauth-protected-resource"`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          result: {
            content: [
              { type: 'text', text: JSON.stringify(connectRequired(publicUrl(event))) },
            ],
            isError: true,
          },
        }),
      };
    }

    return json(200, rpcError(null, -32603, err instanceof Error ? err.message : 'Internal error.'));
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
 * Zod to JSON Schema, minimally.
 *
 * A model reads the descriptions far more than the types, so this deliberately carries
 * every `.describe()` through and keeps type inference shallow — a precise schema with the
 * descriptions dropped would be worse for tool selection than a loose one that keeps them.
 */
function toJsonSchema(schema?: RegisteredTool['inputSchema']): Record<string, unknown> {
  const shape = (schema as unknown as { shape?: Record<string, ZodLike> })?.shape ?? {};
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, field] of Object.entries(shape)) {
    const def = unwrap(field);
    properties[key] = {
      type: def.type,
      ...(def.description ? { description: def.description } : {}),
    };
    if (!def.optional) required.push(key);
  }

  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) };
}

interface ZodLike {
  _def?: { typeName?: string; description?: string; innerType?: ZodLike; defaultValue?: unknown };
}

function unwrap(field: ZodLike): { type: string; description?: string; optional: boolean } {
  let current = field;
  let optional = false;
  let description = current._def?.description;

  while (
    current._def?.typeName === 'ZodOptional' ||
    current._def?.typeName === 'ZodDefault'
  ) {
    optional = true;
    current = current._def.innerType!;
    description = description ?? current._def?.description;
  }

  const typeName = current._def?.typeName ?? '';
  const type =
    typeName === 'ZodNumber'
      ? 'number'
      : typeName === 'ZodBoolean'
        ? 'boolean'
        : typeName === 'ZodArray'
          ? 'array'
          : typeName === 'ZodRecord' || typeName === 'ZodObject'
            ? 'object'
            : 'string';

  return { type, ...(description ? { description } : {}), optional };
}

function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
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
