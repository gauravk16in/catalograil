import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
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
}

export interface MigrationResult {
  readonly bootstrapped: boolean;
  readonly extensions: string[];
  readonly migrationsApplied: boolean;
  readonly seeded: boolean;
}

const secrets = new SecretsManagerClient({});

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

    return {
      bootstrapped: !event.skipBootstrap,
      extensions: applied,
      migrationsApplied: true,
      seeded: Boolean(event.seed),
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
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
