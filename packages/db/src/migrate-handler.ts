import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SendMessageBatchCommand, SQSClient } from '@aws-sdk/client-sqs';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { seed } from './seed.js';

/**
 * Bootstraps and migrates the database, from inside the VPC.
 *
 * This exists because Aurora sits in isolated subnets: there is no route from a laptop or
 * from CI to the cluster, so `pnpm db:migrate` cannot reach a deployed environment. Rather
 * than punch a hole with a bastion, the same migration code runs as a Lambda that is
 * already inside the network.
 *
 * It also answers the question T1.3 left open. Extensions have to exist before the schema
 * that uses them, and CDK cannot run SQL — so "on first boot" happens here, in the one
 * place that already holds the connection and the migration list.
 *
 * Connects **directly to the cluster**, not through RDS Proxy, and with the master secret
 * rather than an IAM token. Both are deliberate: this is the administrative path, and the
 * IAM grant that lets the application authenticate is one of the things it sets up.
 */

interface MigrationEvent {
  /** Set to skip the DDL bootstrap and only apply migrations. */
  readonly skipBootstrap?: boolean;
  /**
   * Runs the same seed data `pnpm db:seed` writes locally (T1.5), through this Lambda's
   * direct-to-cluster connection rather than a route that does not exist from a laptop.
   * Never set true in prod; nothing here checks that, so that is on the caller.
   */
  readonly seed?: boolean;
  /**
   * Enqueues every unindexed product for enrichment, which is what actually gets a
   * deployed catalogue into search.
   *
   * Without this there is no route from a seeded deployed database to `searchable_units`:
   * only the embedding worker writes that table (rule 4 in §8), and the only things that
   * normally reach the enrichment queue are a CSV import and a manual product create.
   * A seeded dev environment therefore returned "no products match" for every query while
   * holding a full catalogue, which looks like a broken search rather than an unindexed one.
   *
   * Safe to re-run: enrichment and embedding are both keyed on `content_hash`, so a second
   * pass over unchanged products re-embeds nothing (rule 9).
   */
  readonly backfill?: boolean;
  /**
   * Removes the demo catalogue seeded by `seed: true`, leaving only what merchants
   * themselves uploaded.
   *
   * Destructive and not reversible without re-seeding, so it reports what it *would* delete
   * unless `confirm` is also set. The three seeded merchants have fixed ids and RFC 2606
   * `.example` addresses, which is what makes "demo" a fact here rather than a guess — a
   * real merchant cannot have either.
   */
  readonly purgeDemo?: boolean;
  readonly confirm?: boolean;
}

export interface MigrationResult {
  readonly bootstrapped: boolean;
  readonly extensions: string[];
  readonly migrationsApplied: boolean;
  readonly seeded: boolean;
  readonly backfilled: number;
  readonly purged?: PurgeResult;
}

export interface PurgeResult {
  readonly dryRun: boolean;
  readonly merchants: { id: string; name: string; email: string }[];
  readonly products: number;
  readonly variants: number;
  readonly searchableUnits: number;
  readonly orders: number;
  /** Anything that looked seeded but has real orders against it, and was therefore kept. */
  readonly keptBecauseOfOrders: string[];
}

const secrets = new SecretsManagerClient({});
const sqs = new SQSClient({});

/** Required before the schema is created; Aurora enables none of them by default. */
const EXTENSIONS = ['vector', 'ltree', 'pg_trgm', 'uuid-ossp'] as const;

export async function handler(event: MigrationEvent = {}): Promise<MigrationResult> {
  const { host, port, username, password, dbname } = await loadCredentials();

  const sql = postgres({
    host,
    port,
    username,
    password,
    database: dbname,
    ssl: 'require',
    max: 1,
    // DDL on a cold Serverless v2 cluster can wait on a resume from zero ACU.
    connect_timeout: 60,
    idle_timeout: 20,
    onnotice: () => {},
  });

  try {
    const applied: string[] = [];

    if (!event.skipBootstrap) {
      for (const extension of EXTENSIONS) {
        await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS "${extension}"`);
        applied.push(extension);
      }

      /**
       * Lets the application authenticate to RDS Proxy with an IAM token instead of a
       * password (rule 11). Without this grant every Lambda connection is refused, and the
       * failure looks like a network problem rather than a permissions one — worth doing
       * here, where it is visible, rather than leaving as a manual step someone forgets.
       */
      await sql.unsafe(`GRANT rds_iam TO "${username}"`).catch(() => {
        // Already granted, or the local role does not exist outside RDS. Not fatal.
      });
    }

    const db = drizzle(sql);
    await migrate(db, { migrationsFolder: './migrations' });

    if (event.seed) {
      await seed(db);
    }

    const backfilled = event.backfill ? await enqueueForEnrichment(sql) : 0;
    const purged = event.purgeDemo ? await purgeDemoData(sql, Boolean(event.confirm)) : undefined;

    return {
      bootstrapped: !event.skipBootstrap,
      extensions: applied,
      migrationsApplied: true,
      seeded: Boolean(event.seed),
      backfilled,
      ...(purged ? { purged } : {}),
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Queues every product that has no indexed searchable unit yet.
 *
 * Driven by a `NOT EXISTS` against `searchable_units` rather than by product status,
 * because status says where a product is in the merchant's workflow and this needs to know
 * whether search can see it — a product left `draft` by a failed embedding is exactly the
 * one to retry, and an `active` product that is already indexed is exactly the one to skip.
 */
async function enqueueForEnrichment(sql: postgres.Sql): Promise<number> {
  const queueUrl = process.env.ENRICHMENT_QUEUE_URL;
  if (!queueUrl) throw new Error('ENRICHMENT_QUEUE_URL is not set.');

  const rows = (await sql`
    SELECT p.id::text AS id, p.merchant_id::text AS merchant_id
    FROM products p
    WHERE p.status <> 'archived'
      AND NOT EXISTS (
        SELECT 1 FROM searchable_units su
        WHERE su.product_id = p.id AND su.embedding_status = 'indexed'
      )`) as unknown as { id: string; merchant_id: string }[];

  // SQS caps a batch at 10; the whole point of batching here is that a catalogue backfill
  // is thousands of messages and one request each would dominate the runtime.
  for (let i = 0; i < rows.length; i += 10) {
    const chunk = rows.slice(i, i + 10);
    await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: chunk.map((row, index) => ({
          Id: String(index),
          MessageBody: JSON.stringify({ productId: row.id, merchantId: row.merchant_id }),
        })),
      }),
    );
  }

  return rows.length;
}

/** The three merchants `seed()` creates. Fixed ids, so this cannot catch a real one. */
const DEMO_MERCHANT_IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
];

/**
 * Deletes the demo catalogue, so only what merchants uploaded remains.
 *
 * Two safeguards, because this cannot be undone from here:
 *
 * A **dry run by default** — it says what it would remove and changes nothing until
 * `confirm` is passed. Getting this wrong deletes a real merchant's catalogue.
 *
 * A **merchant with orders is kept**, whatever their id. `orders.merchant_id` has no
 * cascade on purpose: a buyer's history must not disappear because a merchant row was
 * removed. If a demo merchant somehow has a real order against it, deleting them would
 * either fail on the constraint or orphan that history, and neither is acceptable — so it
 * is reported and skipped.
 */
async function purgeDemoData(sql: postgres.Sql, confirm: boolean): Promise<PurgeResult> {
  const found = (await sql`
    SELECT m.id::text, m.business_name, m.contact_email,
           (SELECT COUNT(*)::int FROM orders o WHERE o.merchant_id = m.id) AS order_count
    FROM merchants m
    WHERE m.id = ANY(${DEMO_MERCHANT_IDS}::uuid[])
       OR m.contact_email LIKE '%.example'`) as unknown as {
    id: string;
    business_name: string;
    contact_email: string;
    order_count: number;
  }[];

  const deletable = found.filter((m) => m.order_count === 0);
  const kept = found.filter((m) => m.order_count > 0);
  const ids = deletable.map((m) => m.id);

  const counts = ids.length
    ? ((await sql`
        SELECT
          (SELECT COUNT(*)::int FROM products WHERE merchant_id = ANY(${ids}::uuid[])) AS products,
          (SELECT COUNT(*)::int FROM product_variants pv
             JOIN products p ON p.id = pv.product_id
            WHERE p.merchant_id = ANY(${ids}::uuid[])) AS variants,
          (SELECT COUNT(*)::int FROM searchable_units WHERE merchant_id = ANY(${ids}::uuid[])) AS units,
          (SELECT COUNT(*)::int FROM orders WHERE merchant_id = ANY(${ids}::uuid[])) AS orders
        `) as unknown as { products: number; variants: number; units: number; orders: number }[])[0]!
    : { products: 0, variants: 0, units: 0, orders: 0 };

  const result: PurgeResult = {
    dryRun: !confirm,
    merchants: deletable.map((m) => ({
      id: m.id,
      name: m.business_name,
      email: m.contact_email,
    })),
    products: counts.products,
    variants: counts.variants,
    searchableUnits: counts.units,
    orders: counts.orders,
    keptBecauseOfOrders: kept.map((m) => `${m.business_name} (${m.order_count} orders)`),
  };

  if (!confirm || ids.length === 0) return result;

  /**
   * Deleting the merchant is enough for the catalogue.
   *
   * `products`, `product_variants`, `searchable_units`, `merchant_policies` and
   * `merchant_payment_config` all cascade from it, so one delete removes the whole tree
   * without a hand-written order that could drift from the schema.
   */
  await sql`DELETE FROM merchants WHERE id = ANY(${ids}::uuid[])`;
  return result;
}

interface Credentials {
  host: string;
  port: number;
  username: string;
  password: string;
  dbname: string;
}

/**
 * Reads the cluster's generated secret. The secret is the source of truth for the endpoint
 * as well as the password, so nothing here has to be threaded through environment
 * variables that could drift from what RDS actually created.
 */
async function loadCredentials(): Promise<Credentials> {
  const secretArn = process.env.DB_SECRET_ARN;
  if (!secretArn) throw new Error('DB_SECRET_ARN is not set.');

  const response = await secrets.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!response.SecretString) throw new Error('Database secret has no value.');

  const parsed = JSON.parse(response.SecretString) as Partial<Credentials> & { engine?: string };
  const host = process.env.DB_CLUSTER_ENDPOINT ?? parsed.host;

  if (!host || !parsed.username || !parsed.password) {
    throw new Error('Database secret is missing host, username or password.');
  }

  return {
    host,
    port: Number(process.env.DB_PORT ?? parsed.port ?? 5432),
    username: parsed.username,
    password: parsed.password,
    dbname: process.env.DATABASE_NAME ?? parsed.dbname ?? 'catalograil',
  };
}
