import { AppError, type Clock } from '@catalograil/core';
import { merchants, type Database } from '@catalograil/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

/**
 * The merchant's own profile.
 *
 * Everything here is what a buyer sees attributed to them — the business name appears on
 * every search result, every product card and every order — and until now it was whatever
 * they typed into the sign-up form and could never change. A merchant who registered as
 * "Kumar Textiles" and trades as "Loomfolk" had no way to say so.
 *
 * The name is joined live into search rather than denormalised into `searchable_units`, and
 * it is not part of the embedded text, so a rename takes effect on the next query with no
 * re-indexing and no re-embedding.
 */

export interface ProfileDeps {
  readonly db: Database;
  readonly clock: Clock;
}

const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

/**
 * Only fields the merchant owns.
 *
 * `status`, `razorpay_account_id` and `gstin_verified` are decided by what the platform has
 * observed, not by what the merchant says — a profile form that could set them would be a
 * form that could mark yourself verified.
 */
const updateSchema = z
  .object({
    businessName: z.string().trim().min(2).max(120),
    legalName: z.string().trim().max(200).nullish(),
    contactPhone: z
      .string()
      .trim()
      .regex(/^(\+91)?[6-9][0-9]{9}$/, 'Enter a 10-digit Indian mobile number.')
      .nullish(),
    gstin: z.string().trim().toUpperCase().regex(GSTIN, 'That is not a valid GSTIN.').nullish(),
    city: z.string().trim().max(80).nullish(),
    state: z.string().trim().max(80).nullish(),
    categories: z.array(z.string().trim().min(1).max(60)).max(12).nullish(),
  })
  .partial({
    legalName: true,
    contactPhone: true,
    gstin: true,
    city: true,
    state: true,
    categories: true,
  });

export interface MerchantProfile {
  readonly merchantId: string;
  readonly businessName: string;
  readonly legalName: string | null;
  readonly contactEmail: string;
  readonly contactPhone: string | null;
  readonly gstin: string | null;
  readonly gstinVerified: boolean;
  readonly city: string | null;
  readonly state: string | null;
  readonly categories: string[];
  readonly status: string;
  readonly createdAt: string;
}

export async function getProfile(db: Database, merchantId: string): Promise<MerchantProfile> {
  const [row] = await db.select().from(merchants).where(eq(merchants.id, merchantId)).limit(1);
  if (!row) throw new AppError('NOT_FOUND', 'No such merchant.');
  return present(row);
}

export async function updateProfile(
  deps: ProfileDeps,
  merchantId: string,
  body: unknown,
): Promise<MerchantProfile> {
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 'Check the highlighted fields.', {
      details: { issues: parsed.error.issues },
    });
  }

  const input = parsed.data;

  /**
   * A GSTIN that changes is a GSTIN that has not been verified.
   *
   * `gstin_verified` records that *this* number was checked. Carrying the flag across a
   * change would let a merchant verify one number and then display a different one as
   * verified, which is precisely the claim the flag exists to make.
   */
  const [existing] = await deps.db
    .select({ gstin: merchants.gstin })
    .from(merchants)
    .where(eq(merchants.id, merchantId))
    .limit(1);
  if (!existing) throw new AppError('NOT_FOUND', 'No such merchant.');

  const gstinChanged = input.gstin !== undefined && (input.gstin ?? null) !== existing.gstin;

  const [updated] = await deps.db
    .update(merchants)
    .set({
      businessName: input.businessName,
      ...(input.legalName !== undefined ? { legalName: emptyToNull(input.legalName) } : {}),
      ...(input.contactPhone !== undefined
        ? { contactPhone: normalisePhone(input.contactPhone) }
        : {}),
      ...(input.gstin !== undefined ? { gstin: emptyToNull(input.gstin) } : {}),
      ...(gstinChanged ? { gstinVerified: false } : {}),
      ...(input.city !== undefined ? { city: emptyToNull(input.city) } : {}),
      ...(input.state !== undefined ? { state: emptyToNull(input.state) } : {}),
      ...(input.categories !== undefined ? { categories: input.categories ?? [] } : {}),
      updatedAt: deps.clock.now(),
    })
    .where(eq(merchants.id, merchantId))
    .returning();

  if (!updated) throw new AppError('NOT_FOUND', 'No such merchant.');
  return present(updated);
}

/**
 * The contact email is deliberately absent from the update schema.
 *
 * It is how a Cognito account is matched to its merchant row, so editing it here would
 * leave the merchant signed in and unable to sign in again — a change that looks like it
 * worked until the next session. Changing it has to move the identity too, and that is a
 * different piece of work than a profile form.
 */
function present(row: typeof merchants.$inferSelect): MerchantProfile {
  return {
    merchantId: row.id,
    businessName: row.businessName,
    legalName: row.legalName ?? null,
    contactEmail: row.contactEmail,
    contactPhone: row.contactPhone ?? null,
    gstin: row.gstin ?? null,
    gstinVerified: row.gstinVerified,
    city: row.city ?? null,
    state: row.state ?? null,
    categories: row.categories ?? [],
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

/** A cleared optional field means null, not the empty string it arrives as from a form. */
function emptyToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/** Stored in E.164, because that is what SMS and WhatsApp both need. */
function normalisePhone(value: string | null | undefined): string | null {
  const trimmed = emptyToNull(value);
  if (!trimmed) return null;
  return trimmed.startsWith('+91') ? trimmed : `+91${trimmed.replace(/\D/g, '')}`;
}
