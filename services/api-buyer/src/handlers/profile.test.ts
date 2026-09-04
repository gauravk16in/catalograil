import { randomUUID } from 'node:crypto';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createAddress,
  deleteAddress,
  getProfile,
  listAddresses,
  setDefaultAddress,
  updateProfile,
} from './profile.js';

const DATABASE_URL = process.env.DATABASE_URL;

const VALID_ADDRESS = {
  label: 'Home',
  recipientName: 'A Buyer',
  recipientPhone: '+919876543210',
  line1: '12 MG Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560001',
};

describe.skipIf(!DATABASE_URL)('buyer profile and addresses', () => {
  let client: postgres.Sql;
  let db: PostgresJsDatabase;
  let buyerId: string;
  let strangerId: string;

  beforeAll(async () => {
    client = postgres(DATABASE_URL!, { max: 2, onnotice: () => {} });
    db = drizzle(client);
    buyerId = randomUUID();
    strangerId = randomUUID();
    await client`INSERT INTO buyers (id, name, email) VALUES
      (${buyerId}, 'A Buyer', ${`b-${buyerId}@example.com`}),
      (${strangerId}, 'Someone Else', ${`s-${strangerId}@example.com`})`;
  });

  afterAll(async () => {
    for (const id of [buyerId, strangerId]) {
      if (id) {
        await client`DELETE FROM buyer_addresses WHERE buyer_id = ${id}`;
        await client`DELETE FROM buyers WHERE id = ${id}`;
      }
    }
    await client?.end();
  });

  it('names what is still missing rather than returning a bare false', async () => {
    // A buyer arrives here because checkout asked them to; the useful answer is which one
    // thing is needed, not a locked door.
    const profile = await getProfile(db as never, buyerId);
    expect(profile.checkoutReady).toBe(false);
    expect(profile.missing).toEqual(['a delivery address']);
  });

  it('makes the first address the default without being asked', async () => {
    // A buyer with exactly one address and no default gets asked to choose between one
    // option at checkout.
    const address = await createAddress(db as never, buyerId, VALID_ADDRESS);
    expect(address.isDefault).toBe(true);

    const profile = await getProfile(db as never, buyerId);
    expect(profile.checkoutReady).toBe(true);
    expect(profile.defaultAddressId).toBe(address.id);
  });

  it('keeps exactly one default when another is promoted', async () => {
    const second = await createAddress(db as never, buyerId, {
      ...VALID_ADDRESS,
      label: 'Office',
      pincode: '560038',
    });
    await setDefaultAddress(db as never, buyerId, second.id as string);

    const { addresses } = await listAddresses(db as never, buyerId);
    expect(addresses.filter((a) => a.isDefault)).toHaveLength(1);
    expect((await getProfile(db as never, buyerId)).defaultAddressId).toBe(second.id);
  });

  it('rejects a PIN code that is not six digits', async () => {
    await expect(
      createAddress(db as never, buyerId, { ...VALID_ADDRESS, pincode: '012' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it("will not read, promote or delete another buyer's address", async () => {
    /**
     * These rows are a home address and a phone number. An id arriving in a request must
     * never be enough to reach one.
     */
    const mine = await createAddress(db as never, buyerId, VALID_ADDRESS);

    expect((await listAddresses(db as never, strangerId)).addresses).toHaveLength(0);
    await expect(
      setDefaultAddress(db as never, strangerId, mine.id as string),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(deleteAddress(db as never, strangerId, mine.id as string)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('clears the default when the default address is deleted', async () => {
    // A dangling default makes checkout select an address that no longer exists.
    const profile = await getProfile(db as never, buyerId);
    await deleteAddress(db as never, buyerId, profile.defaultAddressId!);
    expect((await getProfile(db as never, buyerId)).defaultAddressId).toBeNull();
  });

  it('updates the name but leaves email and phone to Cognito', async () => {
    const updated = await updateProfile(db as never, buyerId, { name: 'Renamed Buyer' });
    expect(updated.name).toBe('Renamed Buyer');
    // Editing them here would let `emailVerified` point at an address nobody has proven
    // they own, so the schema refuses the field outright.
    await expect(
      updateProfile(db as never, buyerId, { name: 'X', email: 'new@example.com' } as never),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
