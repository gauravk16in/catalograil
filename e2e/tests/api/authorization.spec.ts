import { expect, test } from '@playwright/test';
import { apiRequest, merchantToken, readEnv } from '../../lib/auth.js';

/**
 * Journey 6 — authorization.
 *
 * These assert the property that was actually broken: identity came from a request header,
 * so any caller could act as any merchant. Every case here failed before Block B.
 */
const env = readEnv();

test.describe('authorization', () => {
  test.skip(!env, 'Needs API_BASE_URL and E2E merchant credentials.');

  test('rejects an unauthenticated request to a protected route', async () => {
    const response = await apiRequest(env!, '/merchant/products', { token: null });
    expect(response.status).toBe(401);
  });

  test('rejects a malformed token', async () => {
    const response = await apiRequest(env!, '/merchant/products', { token: 'not.a.token' });
    expect(response.status).toBe(401);
  });

  test('serves health without any credential at all', async () => {
    // The one deliberate exception: it must answer when auth is what is broken.
    const response = await apiRequest(env!, '/health', { token: null });
    expect(response.status).toBe(200);
  });

  test('answers the CORS preflight without authentication', async () => {
    /**
     * The bug that broke every dashboard request: `ANY` matched OPTIONS, so the authorizer
     * ran on the preflight and returned 403, and the browser never sent the real request.
     */
    const response = await fetch(`${env!.apiBaseUrl}/merchant/products`, {
      method: 'OPTIONS',
      headers: {
        origin: process.env.MERCHANT_APP_URL ?? 'http://localhost:3000',
        'access-control-request-method': 'GET',
      },
    });
    expect(response.status).toBeLessThan(300);
    expect(response.headers.get('access-control-allow-origin')).not.toBe('*');
  });

  test('ignores a merchant id supplied in the request', async () => {
    /**
     * The headline security assertion. Even with a valid token, a header naming a different
     * merchant must have no effect — this is horizontal privilege escalation if it does.
     */
    const token = await merchantToken(env!);
    const honest = await apiRequest(env!, '/merchant/products', { token });
    const spoofed = await apiRequest(env!, '/merchant/products', {
      token,
      headers: { 'x-merchant-id': '00000000-0000-4000-8000-000000000000' },
    });

    expect(honest.status).toBe(200);
    expect(spoofed.status).toBe(200);
    expect(await spoofed.json()).toEqual(await honest.json());
  });

  test('rejects a merchant token on a buyer route', async () => {
    // Separate pools mean the buyer authorizer does not accept the merchant issuer at all.
    const response = await apiRequest(env!, '/buyer/search', {
      method: 'POST',
      body: JSON.stringify({ query: 'shirt' }),
    });
    expect(response.status).toBe(401);
  });
});
