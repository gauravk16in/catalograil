import { AppError } from '@catalograil/core';
import { buyerAddresses, buyers, merchants, orderItems, orders, type Database } from '@catalograil/db';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

/**
 * S2.6 / S6.5 — the buyer's own account.
 *
 * Everything here is scoped by the buyer id from the validated JWT claim, never from the
 * request. These rows are a home address and a phone number; trusting an id from a request
 * body here would be worse than the merchant equivalent, not better.
 */

export interface BuyerProfile {
  readonly buyerId: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly emailVerified: boolean;
  readonly phoneVerified: boolean;
  readonly defaultAddressId: string | null;
  readonly checkoutReady: boolean;
  readonly missing: string[];
}

export async function getProfile(db: Database, buyerId: string): Promise<BuyerProfile> {
  const [row] = await db.select().from(buyers).where(eq(buyers.id, buyerId)).limit(1);
  if (!row) throw new AppError('NOT_FOUND', 'No such buyer.');

  const addresses = await db
    .select({ id: buyerAddresses.id })
    .from(buyerAddresses)
    .where(eq(buyerAddresses.buyerId, buyerId))
    .limit(1);

  /**
   * Browsing needs nothing; checkout needs a name, a way to reach them, and somewhere to
   * send it. Naming what is missing rather than returning a bare false is what lets the UI
   * ask for one thing instead of showing a locked door.
   */
  const missing: string[] = [];
  if (!row.name?.trim()) missing.push('your name');
  if (!row.email && !row.phone) missing.push('an email or phone number');
  if (addresses.length === 0) missing.push('a delivery address');

  return {
    buyerId: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    emailVerified: row.emailVerified,
    phoneVerified: row.phoneVerified,
    defaultAddressId: row.defaultAddressId,
    checkoutReady: missing.length === 0,
    missing,
  };
}

const profileSchema = z.object({ name: z.string().trim().min(1).max(200) }).strict();

export async function updateProfile(
  db: Database,
  buyerId: string,
  body: unknown,
): Promise<BuyerProfile> {
  const parsed = profileSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 'A name is required.', {
      details: { issues: parsed.error.issues },
    });
  }

  /**
   * Only the name is editable here. Email and phone belong to Cognito, and changing them in
   * this table would let the two disagree — the verified flag would still read verified
   * while pointing at an address nobody has proven they own.
   */
  await db.update(buyers).set({ name: parsed.data.name }).where(eq(buyers.id, buyerId));
  return getProfile(db, buyerId);
}

const addressSchema = z
  .object({
    label: z.string().trim().max(60).optional(),
    recipientName: z.string().trim().min(1).max(200),
    recipientPhone: z.string().trim().min(6).max(20),
    line1: z.string().trim().min(1).max(300),
    line2: z.string().trim().max(300).optional(),
    landmark: z.string().trim().max(200).optional(),
    city: z.string().trim().min(1).max(120),
    state: z.string().trim().min(1).max(120),
    // Indian PIN codes are six digits and never start with zero.
    pincode: z.string().trim().regex(/^[1-9][0-9]{5}$/, 'A PIN code is six digits.'),
    deliveryNotes: z.string().trim().max(500).optional(),
    isDefault: z.boolean().default(false),
  })
  .strict();

export async function listAddresses(
  db: Database,
  buyerId: string,
): Promise<{ addresses: Record<string, unknown>[] }> {
  const rows = await db
    .select()
    .from(buyerAddresses)
    .where(eq(buyerAddresses.buyerId, buyerId))
    .orderBy(desc(buyerAddresses.isDefault), desc(buyerAddresses.createdAt));
  return { addresses: rows as Record<string, unknown>[] };
}

export async function createAddress(
  db: Database,
  buyerId: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const parsed = addressSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 'This address is not complete.', {
      details: { issues: parsed.error.issues },
    });
  }
  const input = parsed.data;

  const existing = await db
    .select({ id: buyerAddresses.id })
    .from(buyerAddresses)
    .where(eq(buyerAddresses.buyerId, buyerId));

  // The first address is the default whether they asked or not: a buyer with exactly one
  // address and no default gets asked to choose between one option at checkout.
  const isDefault = input.isDefault || existing.length === 0;

  if (isDefault) await clearDefaults(db, buyerId);

  const [row] = await db
    .insert(buyerAddresses)
    .values({
      buyerId,
      label: input.label ?? null,
      recipientName: input.recipientName,
      recipientPhone: input.recipientPhone,
      line1: input.line1,
      line2: input.line2 ?? null,
      landmark: input.landmark ?? null,
      city: input.city,
      state: input.state,
      pincode: input.pincode,
      country: 'IN',
      deliveryNotes: input.deliveryNotes ?? null,
      isDefault,
    })
    .returning();

  if (isDefault) {
    await db.update(buyers).set({ defaultAddressId: row!.id }).where(eq(buyers.id, buyerId));
  }
  return row as Record<string, unknown>;
}

export async function setDefaultAddress(
  db: Database,
  buyerId: string,
  addressId: string,
): Promise<{ defaultAddressId: string }> {
  const [owned] = await db
    .select({ id: buyerAddresses.id })
    .from(buyerAddresses)
    // Scoped: an address id from a request must never select someone else's address.
    .where(and(eq(buyerAddresses.id, addressId), eq(buyerAddresses.buyerId, buyerId)))
    .limit(1);

  if (!owned) throw new AppError('NOT_FOUND', 'No such address.');

  await clearDefaults(db, buyerId);
  await db.update(buyerAddresses).set({ isDefault: true }).where(eq(buyerAddresses.id, addressId));
  await db.update(buyers).set({ defaultAddressId: addressId }).where(eq(buyers.id, buyerId));

  return { defaultAddressId: addressId };
}

export async function deleteAddress(
  db: Database,
  buyerId: string,
  addressId: string,
): Promise<{ deleted: boolean }> {
  const result = await db
    .delete(buyerAddresses)
    .where(and(eq(buyerAddresses.id, addressId), eq(buyerAddresses.buyerId, buyerId)))
    .returning({ id: buyerAddresses.id, wasDefault: buyerAddresses.isDefault });

  if (result.length === 0) throw new AppError('NOT_FOUND', 'No such address.');

  // A dangling default would make checkout select an address that no longer exists.
  if (result[0]!.wasDefault) {
    await db.update(buyers).set({ defaultAddressId: null }).where(eq(buyers.id, buyerId));
  }
  return { deleted: true };
}

async function clearDefaults(db: Database, buyerId: string): Promise<void> {
  await db
    .update(buyerAddresses)
    .set({ isDefault: false })
    .where(eq(buyerAddresses.buyerId, buyerId));
}

/** The buyer's own orders. Read-only: a buyer never changes an order's status. */
export async function listBuyerOrders(
  db: Database,
  buyerId: string,
  buyerEmail: string | null,
): Promise<{ orders: Record<string, unknown>[] }> {
  const rows = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      totalPaise: orders.totalPaise,
      createdAt: orders.createdAt,
      /**
       * Enough to make the list readable without opening anything.
       *
       * A page of order numbers and statuses is a database view, not an answer: the two
       * questions someone actually has are "what was this?" and "who has my money?", and
       * both were a click away from a screen that had room for them.
       */
      merchantName: merchants.businessName,
      paymentLinkUrl: orders.paymentLinkUrl,
    })
    .from(orders)
    .leftJoin(merchants, eq(merchants.id, orders.merchantId))
    /**
     * Matched on email when we have one, because guest checkout writes `buyer_email` with
     * no `buyer_id` — an order placed before signing up still belongs to the person who
     * placed it, and they should see it once they have an account.
     */
    .where(buyerEmail ? eq(orders.buyerEmail, buyerEmail) : eq(orders.buyerId, buyerId))
    .orderBy(desc(orders.createdAt))
    .limit(50);

  /**
   * One query for every order's lines, not one per order.
   *
   * Fifty orders would otherwise be fifty round trips through the proxy for a list view,
   * which is the shape of slowness that only shows up once someone has been a customer for
   * a while — the exact people whose page should not get worse.
   */
  const ids = rows.map((row) => row.id);
  const lines = ids.length
    ? await db
        .select({
          orderId: orderItems.orderId,
          productId: orderItems.productId,
          name: orderItems.nameSnapshot,
          options: orderItems.optionsSnapshot,
          quantity: orderItems.quantity,
          lineTotalPaise: orderItems.lineTotalPaise,
        })
        .from(orderItems)
        .where(inArray(orderItems.orderId, ids))
    : [];

  const byOrder = new Map<string, Record<string, unknown>[]>();
  for (const line of lines) {
    const list = byOrder.get(line.orderId) ?? [];
    list.push({
      productId: line.productId,
      name: line.name,
      options: line.options ?? {},
      quantity: line.quantity,
      lineTotalPaise: line.lineTotalPaise?.toString() ?? '0',
    });
    byOrder.set(line.orderId, list);
  }

  return {
    orders: rows.map((row) => ({
      ...row,
      totalPaise: row.totalPaise?.toString() ?? '0',
      createdAt: row.createdAt.toISOString(),
      items: byOrder.get(row.id) ?? [],
    })),
  };
}
