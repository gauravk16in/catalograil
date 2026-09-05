import { describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { handler } from './handler.js';

/**
 * Regression for the other half of a real report: "I didn't get an option to authorize or
 * login — it detected no login, no auth."
 *
 * An assistant only starts an OAuth flow when it is refused, so something has to refuse it.
 * The line is drawn at the personal tools: searching answers anyone, and the first attempt at
 * this challenged the handshake instead, which broke search for exactly the buyers who have
 * no account yet.
 */
process.env.COGNITO_ISSUER ??= 'https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_test';
process.env.COGNITO_MCP_CLIENT_ID ??= 'test-client-id';
process.env.COGNITO_HOSTED_UI ??= 'https://buyers.auth.ap-south-1.amazoncognito.com';
process.env.API_BASE_URL ??= 'https://api.test';
process.env.BUYER_APP_URL ??= 'https://buy.test';

function post(body: unknown, headers: Record<string, string> = {}): APIGatewayProxyEventV2 {
  return {
    rawPath: '/',
    headers: { host: 'mcp.test', ...headers },
    body: JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { requestId: 'req-1', http: { method: 'POST', sourceIp: '1.2.3.4' } },
  } as unknown as APIGatewayProxyEventV2;
}

const asResult = (r: unknown) => r as APIGatewayProxyStructuredResultV2;

const call = (id: number, name: string) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: {} },
});

describe('the authentication boundary', () => {
  it('refuses a personal tool without a token, and says where to authenticate', async () => {
    const response = asResult(await handler(post(call(1, 'place_order'))));

    expect(response.statusCode).toBe(401);
    expect(response.headers?.['www-authenticate']).toBe(
      'Bearer resource_metadata="https://mcp.test/.well-known/oauth-protected-resource"',
    );
    // The id is echoed: a client matching responses to requests must not be left waiting.
    expect(JSON.parse(response.body!).id).toBe(1);
  });

  it('refuses every tool that reads someone’s own data', async () => {
    for (const [index, tool] of ['get_my_addresses', 'list_my_orders', 'get_order_status'].entries()) {
      expect(asResult(await handler(post(call(10 + index, tool)))).statusCode).toBe(401);
    }
  });

  it('lets the handshake through, so a buyer with no account can still connect', async () => {
    const response = asResult(await handler(post({ jsonrpc: '2.0', id: 2, method: 'initialize' })));
    expect(response.statusCode).toBe(200);
  });

  it('lists the tools without a token, personal ones included', async () => {
    const response = asResult(await handler(post({ jsonrpc: '2.0', id: 3, method: 'tools/list' })));
    const names = (JSON.parse(response.body!).result.tools as { name: string }[]).map((t) => t.name);

    expect(response.statusCode).toBe(200);
    // A tool that appears only after signing in cannot prompt anyone to sign in.
    expect(names).toContain('place_order');
    expect(names).toContain('search_products');
  });

  it('does not challenge a search, which is the thing a buyer does before trusting us', async () => {
    const response = asResult(await handler(post(call(4, 'search_products'))));
    expect(response.statusCode).not.toBe(401);
  });

  it('lets a ping through, so liveness checks do not look like auth failures', async () => {
    const response = asResult(await handler(post({ jsonrpc: '2.0', id: 3, method: 'ping' })));
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body!)).toEqual({ jsonrpc: '2.0', id: 3, result: {} });
  });
});

describe('dynamic client registration', () => {
  it('hands back the pre-registered public client', async () => {
    const event = post({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] });
    event.rawPath = '/register';

    const response = asResult(await handler(event));
    const registered = JSON.parse(response.body!) as Record<string, unknown>;

    expect(response.statusCode).toBe(201);
    expect(registered.client_id).toBe('test-client-id');
    expect(registered.token_endpoint_auth_method).toBe('none');
    // A secret here would tell a public client it is confidential and invite it to send one.
    expect(registered.client_secret).toBeUndefined();
  });

  it('advertises that endpoint, which is what makes a client look for it', async () => {
    const event = post(null);
    event.rawPath = '/.well-known/oauth-authorization-server';
    (event.requestContext.http as { method: string }).method = 'GET';

    const metadata = JSON.parse(asResult(await handler(event)).body!) as Record<string, unknown>;
    expect(metadata.registration_endpoint).toBe('https://mcp.test/register');
  });
});
