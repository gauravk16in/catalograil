import { randomUUID } from 'node:crypto';
import { fixedClock } from '@catalograil/core';
import { InMemoryMailer } from '@catalograil/aws';
import { merchantTokens, merchants } from '@catalograil/db';
import { ReversibleTestCipher, type OAuthConfig } from '@catalograil/razorpay';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_REFRESH_FAILURES, runTokenRefresh, type TokenRefreshDeps } from './refresh.js';

/**
 * T1.7 against a real database, because the acceptance criteria are about state that
 * persists across runs: a merchant is suspended on the *third* consecutive failure, which
 * cannot be observed without the counter actually surviving.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const NOW = new Date('2026-09-04T12:00:00Z');

const oauthConfig: OAuthConfig = {
  clientId: 'c',
  clientSecret: 's',
  redirectUri: 'https://m.example/cb',
  authorizeUrl: 'https://auth.razorpay.com/authorize',
  tokenUrl: 'https://auth.razorpay.com/token',
  revokeUrl: 'https://auth.razorpay.com/revoke',
  scopes: ['read_write'],
};

describe.skipIf(!DATABASE_URL)('token refresh worker', () => {
  let client: postgres.Sql;
  let db: PostgresJsDatabase;
  let merchantId: string;

  beforeAll(async () => {
    client = postgres(DATABASE_URL!, { max: 2, onnotice: () => {} });
    db = drizzle(client);
  });

  afterAll(async () => {
    if (merchantId) await client`DELETE FROM merchants WHERE id = ${merchantId}`;
    await client?.end();
  });

  beforeEach(async () => {
    if (merchantId) await client`DELETE FROM merchants WHERE id = ${merchantId}`;
    merchantId = randomUUID();

    const cipher = new ReversibleTestCipher();
    await db.insert(merchants).values({
      id: merchantId,
      businessName: 'Refresh Test Merchant',
      contactEmail: 'refresh@example.com',
      status: 'active',
    });
    await db.insert(merchantTokens).values({
      merchantId,
      accessToken: await cipher.encrypt('old-access'),
      refreshToken: await cipher.encrypt('old-refresh'),
      // Inside the 14-day window, so the scan picks it up.
      accessExpiresAt: new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000),
      refreshExpiresAt: new Date(NOW.getTime() + 300 * 24 * 60 * 60 * 1000),
      refreshFailures: 0,
    });
  });

  function deps(fetchImpl: typeof fetch): TokenRefreshDeps & { mailer: InMemoryMailer } {
    // The worker calls refreshAccessToken, which uses global fetch; stubbing it here keeps
    // the worker's own signature free of a parameter that exists only for tests.
    vi.stubGlobal('fetch', fetchImpl);
    return {
      db: db as unknown as TokenRefreshDeps['db'],
      oauthConfig,
      cipherFor: () => new ReversibleTestCipher(),
      mailer: new InMemoryMailer(),
      clock: fixedClock(NOW),
    };
  }

  const okResponse = () =>
    new Response(
      JSON.stringify({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
        scope: 'read_write',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

  async function tokenRow() {
    const [row] = await db
      .select()
      .from(merchantTokens)
      .where(eq(merchantTokens.merchantId, merchantId));
    return row!;
  }

  async function merchantRow() {
    const [row] = await db.select().from(merchants).where(eq(merchants.id, merchantId));
    return row!;
  }

  // ── Acceptance: a near-expiry token is refreshed ─────────────────────────────

  it('refreshes a token nearing expiry and stores it encrypted', async () => {
    const d = deps(async () => okResponse());
    const outcome = await runTokenRefresh(d);

    expect(outcome.refreshed).toBeGreaterThanOrEqual(1);

    const row = await tokenRow();
    // Rule 3: what lands in the column is ciphertext, never the token itself.
    expect(row.accessToken).not.toContain('new-access');
    expect(await new ReversibleTestCipher().decrypt(row.accessToken)).toBe('new-access');
    expect(row.refreshFailures).toBe(0);
    expect(row.accessExpiresAt.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('leaves a token that is not near expiry alone', async () => {
    await db
      .update(merchantTokens)
      .set({ accessExpiresAt: new Date(NOW.getTime() + 60 * 24 * 60 * 60 * 1000) })
      .where(eq(merchantTokens.merchantId, merchantId));

    let called = false;
    const d = deps(async () => {
      called = true;
      return okResponse();
    });
    await runTokenRefresh(d);
    expect(called).toBe(false);
  });

  // ── Acceptance: suspended after three failures ───────────────────────────────

  describe('repeated failure', () => {
    const refused = async () => new Response('{}', { status: 401 });

    it('counts a failure and warns the merchant without suspending yet', async () => {
      const d = deps(refused);
      const outcome = await runTokenRefresh(d);

      expect(outcome.failed).toBe(1);
      expect(outcome.suspended).toBe(0);
      expect((await tokenRow()).refreshFailures).toBe(1);
      expect((await merchantRow()).status).toBe('active');
      expect(d.mailer.sent[0]?.subject).toMatch(/Action needed/);
      expect(d.mailer.sent[0]?.text).toContain(`attempt 1 of ${MAX_REFRESH_FAILURES}`);
    });

    it('suspends the merchant on the third consecutive failure', async () => {
      for (let i = 0; i < MAX_REFRESH_FAILURES; i++) {
        await runTokenRefresh(deps(refused));
      }

      expect((await merchantRow()).status).toBe('suspended');
      expect((await tokenRow()).refreshFailures).toBe(MAX_REFRESH_FAILURES);
    });

    it('removes a suspended merchant from search, via the T1.16 trigger', async () => {
      // Rule 15: an unsellable listing must not be shown, so suspension is what makes the
      // exclusion real rather than merely recorded.
      await client`
        INSERT INTO products (id, merchant_id, external_ref, archetype, name, status)
        VALUES (gen_random_uuid(), ${merchantId}, 'TR-1', 'SIMPLE', 'Token Test', 'active')`;
      const [product] = await client`SELECT id FROM products WHERE merchant_id = ${merchantId}`;
      await client`
        INSERT INTO searchable_units
          (unit_type, product_id, merchant_id, archetype, merchant_status,
           canonical_text, content_hash, embedding_status)
        VALUES ('product', ${product!.id}, ${merchantId}, 'SIMPLE', 'active',
                'Token Test', 'hash-tr-1', 'indexed')`;

      for (let i = 0; i < MAX_REFRESH_FAILURES; i++) {
        await runTokenRefresh(deps(refused));
      }

      const [unit] = await client`
        SELECT merchant_status FROM searchable_units WHERE merchant_id = ${merchantId}`;
      expect(unit!.merchant_status).toBe('suspended');
    });

    it('tells a suspended merchant their catalogue is paused, not deleted', async () => {
      let mailer: InMemoryMailer | undefined;
      for (let i = 0; i < MAX_REFRESH_FAILURES; i++) {
        const d = deps(refused);
        await runTokenRefresh(d);
        mailer = d.mailer;
      }
      const last = mailer!.sent.at(-1)!;
      expect(last.subject).toMatch(/paused/i);
      expect(last.text).toMatch(/nothing in your catalogue has been deleted/i);
    });

    it('clears the counter once a refresh succeeds', async () => {
      await runTokenRefresh(deps(refused));
      expect((await tokenRow()).refreshFailures).toBe(1);

      await runTokenRefresh(deps(async () => okResponse()));
      // A merchant who fixed the problem must not stay one failure from suspension.
      expect((await tokenRow()).refreshFailures).toBe(0);
    });

    it('skips a merchant who is already suspended', async () => {
      await db.update(merchants).set({ status: 'suspended' }).where(eq(merchants.id, merchantId));
      const outcome = await runTokenRefresh(deps(refused));
      expect(outcome.examined).toBe(0);
    });
  });

  it('keeps going when the notification fails', async () => {
    const d = deps(async () => new Response('{}', { status: 401 }));
    const outcome = await runTokenRefresh({
      ...d,
      mailer: {
        async send() {
          throw new Error('SES down');
        },
      },
    });
    // The refresh outcome is what matters; a lost email must not abandon the run.
    expect(outcome.failed).toBe(1);
  });
});
