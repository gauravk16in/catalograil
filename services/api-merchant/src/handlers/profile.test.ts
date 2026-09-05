import { randomUUID } from 'node:crypto';
import { fixedClock } from '@catalograil/core';
import { merchants } from '@catalograil/db';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getProfile, updateProfile, type ProfileDeps } from './profile.js';

const DATABASE_URL = process.env.DATABASE_URL;
const NOW = new Date('2026-09-05T12:00:00Z');

describe.skipIf(!DATABASE_URL)('the merchant profile', () => {
  let client: postgres.Sql;
  let db: PostgresJsDatabase;
  let merchantId: string;
  const created: string[] = [];

  beforeAll(() => {
    client = postgres(DATABASE_URL!, { max: 2, onnotice: () => {} });
    db = drizzle(client);
  });

  beforeEach(async () => {
    merchantId = randomUUID();
    created.push(merchantId);
    await db.insert(merchants).values({
      id: merchantId,
      businessName: 'Kumar Textiles',
      contactEmail: `profile-${merchantId}@example.com`,
      status: 'active',
    });
  });

  afterAll(async () => {
    for (const id of created) await db.delete(merchants).where(eq(merchants.id, id));
    await client?.end();
  });

  const deps = (): ProfileDeps => ({ db: db as unknown as ProfileDeps['db'], clock: fixedClock(NOW) });

  it('renames the business, which is what buyers see attributed to them', async () => {
    const profile = await updateProfile(deps(), merchantId, { businessName: 'Loomfolk' });
    expect(profile.businessName).toBe('Loomfolk');
    expect((await getProfile(db as never, merchantId)).businessName).toBe('Loomfolk');
  });

  it('stores a phone in E.164, whichever way it was typed', async () => {
    const profile = await updateProfile(deps(), merchantId, {
      businessName: 'Loomfolk',
      contactPhone: '9876543210',
    });
    // SMS and WhatsApp both need the country code; the merchant should not have to know that.
    expect(profile.contactPhone).toBe('+919876543210');
  });

  it('clears an optional field the merchant emptied, rather than storing ""', async () => {
    await updateProfile(deps(), merchantId, { businessName: 'Loomfolk', city: 'Chennai' });
    const profile = await updateProfile(deps(), merchantId, { businessName: 'Loomfolk', city: '' });
    expect(profile.city).toBeNull();
  });

  it('un-verifies a GSTIN that changed', async () => {
    await db
      .update(merchants)
      .set({ gstin: '29ABCDE1234F1Z5', gstinVerified: true })
      .where(eq(merchants.id, merchantId));

    const profile = await updateProfile(deps(), merchantId, {
      businessName: 'Kumar Textiles',
      gstin: '27ABCDE1234F1Z5',
    });

    // The flag records that *this* number was checked. Carrying it across a change would let
    // a merchant verify one number and display another as verified.
    expect(profile.gstin).toBe('27ABCDE1234F1Z5');
    expect(profile.gstinVerified).toBe(false);
  });

  it('keeps the verified flag when the GSTIN is untouched', async () => {
    await db
      .update(merchants)
      .set({ gstin: '29ABCDE1234F1Z5', gstinVerified: true })
      .where(eq(merchants.id, merchantId));

    const profile = await updateProfile(deps(), merchantId, { businessName: 'Renamed Only' });
    expect(profile.gstinVerified).toBe(true);
  });

  it('refuses a name that is not one, and says which field', async () => {
    await expect(updateProfile(deps(), merchantId, { businessName: 'x' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('ignores anything the merchant does not get to decide', async () => {
    await updateProfile(deps(), merchantId, {
      businessName: 'Loomfolk',
      status: 'active',
      gstinVerified: true,
      razorpayAccountId: 'acc_attacker',
    } as never);

    const [row] = await db.select().from(merchants).where(eq(merchants.id, merchantId));
    // A profile form that could set these would be a form that marks yourself verified.
    expect(row!.gstinVerified).toBe(false);
    expect(row!.razorpayAccountId).toBeNull();
  });

  it('does not let the contact email be edited, because it is the account link', async () => {
    const before = await getProfile(db as never, merchantId);
    await updateProfile(deps(), merchantId, {
      businessName: 'Loomfolk',
      contactEmail: 'someone-else@example.com',
    } as never);

    // Editing it here would leave them signed in and unable to sign in again.
    expect((await getProfile(db as never, merchantId)).contactEmail).toBe(before.contactEmail);
  });
});
