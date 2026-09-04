/**
 * S2.4 — give existing merchants a Cognito user.
 *
 * Merchant rows predate Cognito: seeded catalogues and anything the old Razorpay OAuth
 * flow created have no `cognito_sub`, so nobody can sign in and reach them. This creates a
 * user per merchant, links it, and emails a password reset.
 *
 * **Dry run by default.** It creates real accounts and sends real email, and the only
 * thing worse than not running it is running it twice against production. Pass `--apply`.
 *
 * Idempotent: merchants that already have a `cognito_sub` are skipped, and a Cognito user
 * that already exists is linked rather than recreated. The post-confirmation trigger
 * conflicts on email for the same reason, so the two are safe in either order.
 */
import {
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
  UsernameExistsException,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';
import { merchants } from '@catalograil/db';
import { eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

const APPLY = process.argv.includes('--apply');
const POOL_ID = process.env.MERCHANT_USER_POOL_ID;
const DATABASE_URL = process.env.DATABASE_URL;

/**
 * `.example`, `.test`, `.invalid` and `.localhost` are reserved by RFC 2606 and can never
 * be real. Seeded merchants use them, and creating Cognito users for addresses that cannot
 * receive mail would produce accounts nobody can ever complete a password reset for — plus
 * a burst of SES bounces, which damages the sending reputation the real merchants depend on.
 */
const UNROUTABLE = /\.(example|test|invalid|localhost)$/i;

async function main(): Promise<void> {
  if (!DATABASE_URL) throw new Error('DATABASE_URL is not set.');
  if (!POOL_ID) throw new Error('MERCHANT_USER_POOL_ID is not set.');

  const sql = postgres(DATABASE_URL, { max: 2, onnotice: () => {} });
  const db = drizzle(sql);
  const cognito = new CognitoIdentityProviderClient({});

  try {
    const rows = await db
      .select({ id: merchants.id, email: merchants.contactEmail, name: merchants.businessName })
      .from(merchants)
      .where(isNull(merchants.cognitoSub));

    console.log(`${rows.length} merchant(s) without a Cognito user.`);
    if (!APPLY) console.log('DRY RUN — pass --apply to make changes.\n');

    let created = 0;
    let linked = 0;
    let skipped = 0;

    for (const row of rows) {
      if (UNROUTABLE.test(row.email)) {
        console.log(`  skip   ${row.email}  (reserved domain — seed data, not a real merchant)`);
        skipped++;
        continue;
      }

      if (!APPLY) {
        console.log(`  would  ${row.email}  -> create user, link ${row.id}, send reset`);
        created++;
        continue;
      }

      const sub = await ensureUser(cognito, POOL_ID, row.email, row.name, row.id);
      if (sub.existed) linked++;
      else created++;

      await db.update(merchants).set({ cognitoSub: sub.sub }).where(eq(merchants.id, row.id));
      console.log(`  ${sub.existed ? 'link  ' : 'create'} ${row.email}  -> ${row.id}`);
    }

    console.log(
      `\n${APPLY ? 'Done' : 'Would'}: ${created} created, ${linked} linked, ${skipped} skipped.`,
    );
    if (skipped > 0) {
      console.log(
        'Skipped rows keep their catalogue and stay reachable: if a real person ever signs ' +
          'up with that address, the post-confirmation trigger attaches them to it.',
      );
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function ensureUser(
  cognito: CognitoIdentityProviderClient,
  poolId: string,
  email: string,
  name: string,
  merchantId: string,
): Promise<{ sub: string; existed: boolean }> {
  const existing = await getUser(cognito, poolId, email);
  if (existing) {
    // Link the pre-existing user rather than failing: re-running must converge, not throw.
    await cognito.send(
      new AdminUpdateUserAttributesCommand({
        UserPoolId: poolId,
        Username: email,
        UserAttributes: [{ Name: 'custom:merchant_id', Value: merchantId }],
      }),
    );
    return { sub: existing, existed: true };
  }

  try {
    const result = await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: poolId,
        Username: email,
        /**
         * Cognito emails the temporary password itself, and the user is forced to change
         * it on first sign-in. That is the password reset S2.4 asks for, and it avoids
         * this script ever handling a credential.
         */
        DesiredDeliveryMediums: ['EMAIL'],
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'email_verified', Value: 'true' },
          { Name: 'name', Value: name },
          { Name: 'custom:merchant_id', Value: merchantId },
        ],
      }),
    );
    const sub = result.User?.Attributes?.find((a) => a.Name === 'sub')?.Value;
    if (!sub) throw new Error(`Cognito returned no sub for ${email}.`);
    return { sub, existed: false };
  } catch (err) {
    if (err instanceof UsernameExistsException) {
      // Raced with another run, or with a self-signup. Re-read and link.
      const sub = await getUser(cognito, poolId, email);
      if (!sub) throw err;
      return { sub, existed: true };
    }
    throw err;
  }
}

async function getUser(
  cognito: CognitoIdentityProviderClient,
  poolId: string,
  email: string,
): Promise<string | undefined> {
  try {
    const user = await cognito.send(
      new AdminGetUserCommand({ UserPoolId: poolId, Username: email }),
    );
    return user.UserAttributes?.find((a) => a.Name === 'sub')?.Value;
  } catch (err) {
    if (err instanceof UserNotFoundException) return undefined;
    throw err;
  }
}

await main();
