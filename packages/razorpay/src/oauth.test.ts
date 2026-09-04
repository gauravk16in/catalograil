import { describe, expect, it } from 'vitest';
import {
  buildAuthorizeRedirect,
  exchangeAuthorizationCode,
  parseTokenResponse,
  refreshAccessToken,
  type OAuthConfig,
  type OAuthStatePayload,
  type OAuthStateStore,
} from './oauth.js';
import { ReversibleTestCipher } from './tokens.js';
import {
  describePolicyFailures,
  parseExtraction,
  policiesAreComplete,
  stripHtml,
  type PolicyFetchResult,
} from './policies.js';

const config: OAuthConfig = {
  clientId: 'test-client',
  clientSecret: 'test-secret',
  redirectUri: 'https://merchant.example/api/oauth/callback',
  authorizeUrl: 'https://auth.razorpay.com/authorize',
  tokenUrl: 'https://auth.razorpay.com/token',
  revokeUrl: 'https://auth.razorpay.com/revoke',
  scopes: ['read_write'],
};

/** Single-use by construction, which is the property the real store must also have. */
class MemoryStateStore implements OAuthStateStore {
  private readonly entries = new Map<string, OAuthStatePayload>();

  async put(state: string, payload: OAuthStatePayload): Promise<void> {
    this.entries.set(state, payload);
  }

  async consume(state: string): Promise<OAuthStatePayload | undefined> {
    const payload = this.entries.get(state);
    this.entries.delete(state);
    return payload;
  }
}

function tokenResponse(over: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      access_token: 'rzp_access_abc',
      refresh_token: 'rzp_refresh_xyz',
      expires_in: 3600,
      scope: 'read_write',
      razorpay_account_id: 'acc_test123',
      ...over,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('authorize redirect', () => {
  it('sends the merchant to Razorpay with a stored state', async () => {
    const store = new MemoryStateStore();
    const { url, state } = await buildAuthorizeRedirect(config, store);

    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://auth.razorpay.com/authorize');
    expect(parsed.searchParams.get('client_id')).toBe('test-client');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('state')).toBe(state);
    expect(await store.consume(state)).toBeDefined();
  });

  it('mints a different state every time', async () => {
    const store = new MemoryStateStore();
    const a = await buildAuthorizeRedirect(config, store);
    const b = await buildAuthorizeRedirect(config, store);
    expect(a.state).not.toBe(b.state);
  });
});

describe('code exchange', () => {
  it('exchanges a valid code for tokens', async () => {
    const store = new MemoryStateStore();
    const { state } = await buildAuthorizeRedirect(config, store);

    const { tokens } = await exchangeAuthorizationCode(
      config,
      store,
      { code: 'auth-code', state },
      async () => tokenResponse(),
    );

    expect(tokens.accessToken).toBe('rzp_access_abc');
    expect(tokens.refreshToken).toBe('rzp_refresh_xyz');
    expect(tokens.razorpayAccountId).toBe('acc_test123');
    // Relative expiry is converted to absolute, or the refresh worker's scan is meaningless.
    expect(tokens.accessExpiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  /**
   * The security property this whole flow rests on. A replayed callback that still worked
   * could bind an attacker's Razorpay account to a merchant's session.
   */
  it('rejects a replayed state', async () => {
    const store = new MemoryStateStore();
    const { state } = await buildAuthorizeRedirect(config, store);

    await exchangeAuthorizationCode(config, store, { code: 'c', state }, async () =>
      tokenResponse(),
    );

    await expect(
      exchangeAuthorizationCode(config, store, { code: 'c', state }, async () => tokenResponse()),
    ).rejects.toMatchObject({ code: 'INVALID_OAUTH_STATE' });
  });

  it('rejects a state we never issued', async () => {
    await expect(
      exchangeAuthorizationCode(
        config,
        new MemoryStateStore(),
        { code: 'c', state: 'not-ours' },
        async () => tokenResponse(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_OAUTH_STATE' });
  });

  it('does not call Razorpay at all when the state is bad', async () => {
    let called = false;
    await expect(
      exchangeAuthorizationCode(
        config,
        new MemoryStateStore(),
        { code: 'c', state: 'nope' },
        async () => {
          called = true;
          return tokenResponse();
        },
      ),
    ).rejects.toThrow();
    expect(called).toBe(false);
  });

  it('treats a Razorpay 5xx as retryable and a 4xx as not', async () => {
    const store = new MemoryStateStore();
    const a = await buildAuthorizeRedirect(config, store);
    await expect(
      exchangeAuthorizationCode(
        config,
        store,
        { code: 'c', state: a.state },
        async () => new Response('{}', { status: 503 }),
      ),
    ).rejects.toMatchObject({ retryable: true });

    const b = await buildAuthorizeRedirect(config, store);
    await expect(
      exchangeAuthorizationCode(
        config,
        store,
        { code: 'c', state: b.state },
        async () => new Response('{}', { status: 400 }),
      ),
    ).rejects.toMatchObject({ retryable: false });
  });
});

describe('token refresh (T1.7)', () => {
  it('returns a fresh access token', async () => {
    const tokens = await refreshAccessToken(config, 'rzp_refresh_xyz', async () =>
      tokenResponse({ access_token: 'rzp_access_new' }),
    );
    expect(tokens.accessToken).toBe('rzp_access_new');
  });

  it('marks a revoked grant as not worth retrying', async () => {
    // A 4xx means the merchant revoked us; retrying cannot fix that, and the worker should
    // move straight to suspending them rather than burning three attempts.
    await expect(
      refreshAccessToken(config, 'dead', async () => new Response('{}', { status: 401 })),
    ).rejects.toMatchObject({ code: 'MERCHANT_TOKEN_EXPIRED', retryable: false });
  });

  it('marks a Razorpay outage as retryable', async () => {
    await expect(
      refreshAccessToken(config, 'ok', async () => new Response('{}', { status: 502 })),
    ).rejects.toMatchObject({ retryable: true });
  });
});

describe('parseTokenResponse', () => {
  it('refuses a response missing either token', () => {
    expect(() => parseTokenResponse({ access_token: 'only-one' })).toThrow(/both tokens/);
  });

  it('falls back to an hour when no expiry is given', () => {
    const tokens = parseTokenResponse({ access_token: 'a', refresh_token: 'r' });
    const seconds = (tokens.accessExpiresAt.getTime() - Date.now()) / 1000;
    expect(seconds).toBeGreaterThan(3500);
    expect(seconds).toBeLessThan(3700);
  });
});

describe('token encryption (rule 3)', () => {
  it('round-trips a token', async () => {
    const cipher = new ReversibleTestCipher();
    const encrypted = await cipher.encrypt('rzp_access_secret');
    expect(encrypted).not.toContain('rzp_access_secret');
    expect(await cipher.decrypt(encrypted)).toBe('rzp_access_secret');
  });
});

describe('policy validation (T1.9)', () => {
  const ok = (kind: PolicyFetchResult['kind']): PolicyFetchResult => ({
    kind,
    url: `https://m.example/${kind}`,
    status: 'ok',
    text: 'x'.repeat(300),
  });

  it('requires all three policies before a merchant can go active', () => {
    expect(policiesAreComplete([ok('refund'), ok('terms'), ok('fulfillment')])).toBe(true);
    expect(policiesAreComplete([ok('refund'), ok('terms')])).toBe(false);
  });

  it('names the specific failure so the wizard can show it', () => {
    const failures = describePolicyFailures([
      ok('refund'),
      {
        kind: 'terms',
        url: 'https://m.example/terms',
        status: 'unreachable',
        reason: 'The page returned HTTP 404.',
      },
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('404');
    expect(failures[0]).toContain('terms');
  });

  it('strips scripts before counting characters', () => {
    // Otherwise an empty policy page passes on its analytics tag alone.
    const html =
      '<html><script>var a = "' + 'x'.repeat(500) + '";</script><body>Short.</body></html>';
    expect(stripHtml(html)).toBe('Short.');
  });

  it('decodes entities and collapses whitespace', () => {
    expect(stripHtml('<p>Returns &amp; refunds\n\n   within 7 days</p>')).toBe(
      'Returns & refunds within 7 days',
    );
  });
});

describe('policy extraction', () => {
  it('parses a well-formed extraction', () => {
    const extracted = parseExtraction(
      JSON.stringify({
        return_window_days: 7,
        return_shipping_by: 'merchant',
        dispatch_sla_hours: 48,
        refund_summary: 'Returns accepted within 7 days.',
        terms_summary: null,
        fulfillment_summary: 'Dispatched in two business days.',
      }),
    );
    expect(extracted.returnWindowDays).toBe(7);
    expect(extracted.returnShippingBy).toBe('merchant');
    expect(extracted.dispatchSlaHours).toBe(48);
  });

  it('keeps a zero return window, which means returns are refused', () => {
    // A truthiness check would turn this into null and misreport "no returns" as
    // "not stated" — a materially different claim to make to a buyer.
    expect(parseExtraction(JSON.stringify({ return_window_days: 0 })).returnWindowDays).toBe(0);
  });

  it('rejects an invented shipping party', () => {
    expect(
      parseExtraction(JSON.stringify({ return_shipping_by: 'someone' })).returnShippingBy,
    ).toBeNull();
  });

  it('discards a non-integer window rather than rounding it', () => {
    expect(
      parseExtraction(JSON.stringify({ return_window_days: 'seven' })).returnWindowDays,
    ).toBeNull();
  });

  it('throws on unparseable output', () => {
    expect(() => parseExtraction('not json')).toThrow(/valid JSON/);
  });
});
