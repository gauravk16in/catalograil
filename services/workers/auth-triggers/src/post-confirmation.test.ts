import { randomUUID } from 'node:crypto';
import { buyers, merchants } from '@catalograil/db';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PostConfirmationTriggerEvent } from 'aws-lambda';
import {
  handleBuyerConfirmation,
  handleMerchantConfirmation,
  type TriggerDeps,
} from './post-confirmation.js';

const DATABASE_URL = process.env.DATABASE_URL;

/**
 * Run against a real Postgres, not a mock.
 *
 * The first deployed sign-up failed with "no unique or exclusion constraint matching the
 * ON CONFLICT specification" — `merchants.contact_email` had no unique index, so the
 * upsert had nothing to conflict on. No mock would have caught that, because the bug was
 * in the database's shape rather than in this code.
 */
describe.skipIf(!DATABASE_URL)('post-confirmation triggers', () => {
  let client: postgres.Sql;
  let db: PostgresJsDatabase;
  const created: string[] = [];

  beforeAll(() => {
    client = postgres(DATABASE_URL!, { max: 2, onnotice: () => {} });
    db = drizzle(client);
  });

  afterAll(async () => {
    for (const email of created) {
      await client`DELETE FROM merchants WHERE contact_email = ${email}`;
      await client`DELETE FROM buyers WHERE email = ${email}`;
    }
    await client?.end();
  });

  function deps(written: Record<string, string> = {}): TriggerDeps {
    return {
      db: db as never,
      setUserAttribute: async (_pool, _user, name, value) => {
        written[name] = value;
      },
    };
  }

  function event(attrs: Record<string, string>): PostConfirmationTriggerEvent {
    return {
      userPoolId: 'pool-1',
      userName: attrs.email ?? attrs.phone_number ?? 'user',
      request: { userAttributes: attrs },
      response: {},
    } as unknown as PostConfirmationTriggerEvent;
  }

  it('creates a merchant and writes the id back onto the user', async () => {
    const email = `trigger-${randomUUID()}@example.com`;
    created.push(email);
    const written: Record<string, string> = {};

    await handleMerchantConfirmation(
      event({ sub: randomUUID(), email, name: 'Trigger Test Shop' }),
      deps(written),
    );

    const [row] = await db.select().from(merchants).where(eq(merchants.contactEmail, email));
    expect(row?.businessName).toBe('Trigger Test Shop');
    expect(row?.status).toBe('pending');
    expect(written['custom:merchant_id']).toBe(row?.id);
  });

  it('is safe to run twice, because Cognito retries triggers', async () => {
    const email = `retry-${randomUUID()}@example.com`;
    created.push(email);
    const sub = randomUUID();
    const first: Record<string, string> = {};

    await handleMerchantConfirmation(event({ sub, email, name: 'Retry Shop' }), deps(first));
    // The retry arrives before the attribute write is visible, so it looks like a new user.
    await handleMerchantConfirmation(event({ sub, email, name: 'Retry Shop' }), deps({}));

    const rows = await db.select().from(merchants).where(eq(merchants.contactEmail, email));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(first['custom:merchant_id']);
  });

  it('does nothing when the user is already linked', async () => {
    const written: Record<string, string> = {};
    await handleMerchantConfirmation(
      event({ sub: randomUUID(), email: 'linked@example.com', 'custom:merchant_id': 'already' }),
      deps(written),
    );
    // No write, and no row created for an email we never registered.
    expect(written).toEqual({});
  });

  it('attaches a confirming user to the merchant that already owns their catalogue', async () => {
    /**
     * The case that makes seeded and pre-existing merchants usable: a row exists from
     * before Cognito, and the person now signing up is that merchant. Conflicting on email
     * links them instead of orphaning the catalogue behind a duplicate account.
     */
    const email = `existing-${randomUUID()}@example.com`;
    created.push(email);
    const existingId = randomUUID();
    await client`
      INSERT INTO merchants (id, business_name, contact_email, status)
      VALUES (${existingId}, 'Pre-existing Catalogue', ${email}, 'active')`;

    const written: Record<string, string> = {};
    const sub = randomUUID();
    await handleMerchantConfirmation(event({ sub, email, name: 'Ignored New Name' }), deps(written));

    const [row] = await db.select().from(merchants).where(eq(merchants.contactEmail, email));
    expect(row?.id).toBe(existingId);
    // Their chosen name survives; only the identity link is added.
    expect(row?.businessName).toBe('Pre-existing Catalogue');
    expect(row?.cognitoSub).toBe(sub);
    expect(written['custom:merchant_id']).toBe(existingId);
  });

  it('never overwrites a cognito sub that is already set', async () => {
    const email = `taken-${randomUUID()}@example.com`;
    created.push(email);
    const originalSub = randomUUID();
    await client`
      INSERT INTO merchants (id, business_name, contact_email, status, cognito_sub)
      VALUES (${randomUUID()}, 'Owned', ${email}, 'active', ${originalSub})`;

    await handleMerchantConfirmation(
      event({ sub: randomUUID(), email, name: 'Impostor' }),
      deps({}),
    );

    const [row] = await db.select().from(merchants).where(eq(merchants.contactEmail, email));
    expect(row?.cognitoSub).toBe(originalSub);
  });

  it('refuses a confirmed user with no email', async () => {
    await expect(
      handleMerchantConfirmation(event({ sub: randomUUID() }), deps({})),
    ).rejects.toThrow(/email/i);
  });

  it('creates a buyer from a phone-only signup', async () => {
    const phone = `+9199${Math.floor(10000000 + Math.random() * 89999999)}`;
    const written: Record<string, string> = {};
    try {
      await handleBuyerConfirmation(
        event({ sub: randomUUID(), phone_number: phone, phone_number_verified: 'true' }),
        deps(written),
      );
      const [row] = await db.select().from(buyers).where(eq(buyers.phone, phone));
      expect(row?.phoneVerified).toBe(true);
      expect(written['custom:buyer_id']).toBe(row?.id);
    } finally {
      await client`DELETE FROM buyers WHERE phone = ${phone}`;
    }
  });

  it('refuses a buyer with neither email nor phone', async () => {
    await expect(handleBuyerConfirmation(event({ sub: randomUUID() }), deps({}))).rejects.toThrow(
      /neither email nor phone/i,
    );
  });
});
