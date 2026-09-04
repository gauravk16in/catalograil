import {
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { buyers, merchants, type Database } from '@catalograil/db';
import { eq, sql } from 'drizzle-orm';
import type { PostConfirmationTriggerEvent } from 'aws-lambda';

/**
 * S2.2 — turn a confirmed Cognito user into a row this system can act on.
 *
 * **Cognito retries triggers**, and it retries them on the same user, so everything here
 * has to be safe to run twice. The two dangerous moments are both handled below: creating
 * a second row for an email that already has one, and minting a second id for a user whose
 * `custom:*_id` was already written on an earlier attempt.
 *
 * A failure here fails the sign-up. That is the right trade for the merchant pool — a
 * confirmed user with no merchant row is an account that can log in and do nothing, which
 * is worse than a sign-up they can retry — and it is why the write is a single idempotent
 * upsert rather than a sequence that can half-succeed.
 */

const cognito = new CognitoIdentityProviderClient({});

export interface TriggerDeps {
  readonly db: Database;
  /** Injected so tests need no AWS. */
  readonly setUserAttribute?: (
    userPoolId: string,
    username: string,
    name: string,
    value: string,
  ) => Promise<void>;
}

export async function handleMerchantConfirmation(
  event: PostConfirmationTriggerEvent,
  deps: TriggerDeps,
): Promise<PostConfirmationTriggerEvent> {
  const attrs = event.request.userAttributes;
  const email = attrs.email;
  const sub = attrs.sub;

  if (!email || !sub) {
    throw new Error('Confirmed user has no email or sub; cannot create a merchant.');
  }

  // Already linked on a previous attempt — nothing to do, and re-running must not mint a
  // second id or a second row.
  const existingId = attrs['custom:merchant_id'];
  if (existingId) return event;

  const businessName = attrs.name?.trim() || email.split('@')[0]!;

  /**
   * Upsert on email, not insert.
   *
   * Two rows can already exist for one person: a merchant seeded or created by the old
   * OAuth flow, and the Cognito user now confirming. Conflicting on email attaches the new
   * identity to the existing catalogue instead of orphaning it behind a duplicate account —
   * which is also what makes S2.4's backfill and this trigger safe to run in either order.
   */
  const [row] = await deps.db
    .insert(merchants)
    .values({
      contactEmail: email,
      businessName,
      cognitoSub: sub,
      status: 'pending',
      ...(attrs.phone_number ? { contactPhone: attrs.phone_number } : {}),
    })
    .onConflictDoUpdate({
      target: merchants.contactEmail,
      // COALESCE so a re-run cannot overwrite a sub that is already set, and so an
      // existing merchant keeps the business name they chose rather than having it
      // replaced by one derived from their email address.
      set: {
        cognitoSub: sql`COALESCE(${merchants.cognitoSub}, EXCLUDED.cognito_sub)`,
        updatedAt: new Date(),
      },
    })
    .returning({ id: merchants.id });

  const merchantId = row?.id ?? (await findMerchantIdByEmail(deps.db, email));
  if (!merchantId) throw new Error('Merchant row was neither created nor found.');

  await writeAttribute(deps, event, 'custom:merchant_id', merchantId);
  return event;
}

export async function handleBuyerConfirmation(
  event: PostConfirmationTriggerEvent,
  deps: TriggerDeps,
): Promise<PostConfirmationTriggerEvent> {
  const attrs = event.request.userAttributes;
  const sub = attrs.sub;
  if (!sub) throw new Error('Confirmed user has no sub; cannot create a buyer.');

  if (attrs['custom:buyer_id']) return event;

  const email = attrs.email ?? null;
  const phone = attrs.phone_number ?? null;
  if (!email && !phone) {
    throw new Error('Confirmed buyer has neither email nor phone.');
  }

  /**
   * Conflicts on whichever identifier the buyer actually signed up with.
   *
   * The buyer pool allows either, and the table has a unique index on each. Targeting the
   * wrong one would raise a unique violation rather than merging, so the target follows
   * the identifier that is present.
   */
  const [row] = await deps.db
    .insert(buyers)
    .values({
      cognitoSub: sub,
      email,
      phone,
      ...(attrs.name ? { name: attrs.name } : {}),
      emailVerified: attrs.email_verified === 'true',
      phoneVerified: attrs.phone_number_verified === 'true',
    })
    .onConflictDoUpdate({
      target: email ? buyers.email : buyers.phone,
      set: {
        cognitoSub: sql`COALESCE(${buyers.cognitoSub}, EXCLUDED.cognito_sub)`,
      },
    })
    .returning({ id: buyers.id });

  const buyerId = row?.id;
  if (!buyerId) throw new Error('Buyer row was neither created nor found.');

  await writeAttribute(deps, event, 'custom:buyer_id', buyerId);
  return event;
}

async function findMerchantIdByEmail(db: Database, email: string): Promise<string | undefined> {
  const [row] = await db
    .select({ id: merchants.id })
    .from(merchants)
    .where(eq(merchants.contactEmail, email))
    .limit(1);
  return row?.id;
}

async function writeAttribute(
  deps: TriggerDeps,
  event: PostConfirmationTriggerEvent,
  name: string,
  value: string,
): Promise<void> {
  const write =
    deps.setUserAttribute ??
    (async (userPoolId, username, attrName, attrValue) => {
      await cognito.send(
        new AdminUpdateUserAttributesCommand({
          UserPoolId: userPoolId,
          Username: username,
          UserAttributes: [{ Name: attrName, Value: attrValue }],
        }),
      );
    });

  await write(event.userPoolId, event.userName, name, value);
}
