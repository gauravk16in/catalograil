import { describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { handler } from './handler.js';

/**
 * Regression for the other half of a real report: "I didn't get an option to authorize or
 * login — it detected no login, no auth."
 *
 * An assistant only starts an OAuth flow when it is refused. Leaving the handshake open let
 * Claude connect anonymously and discover the account requirement much later, mid-answer.
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

describe('connect-time challenge', () => {
  it('refuses the handshake without a token, and says where to authenticate', async () => {
    const response = asResult(await handler(post({ jsonrpc: '2.0', id: 1, method: 'initialize' })));

    expect(response.statusCode).toBe(401);
    expect(response.headers?.['www-authenticate']).toBe(
      'Bearer resource_metadata="https://mcp.test/.well-known/oauth-protected-resource"',
    );
    // The id is echoed: a client matching responses to requests must not be left waiting.
    expect(JSON.parse(response.body!).id).toBe(1);
  });

  it('refuses tools/list too, since a connector lists before it calls', async () => {
    const response = asResult(await handler(post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })));
    expect(response.statusCode).toBe(401);
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
