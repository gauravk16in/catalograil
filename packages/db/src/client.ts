import { Signer } from '@aws-sdk/rds-signer';
import { AppError } from '@catalograil/core';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export type Database = PostgresJsDatabase<typeof schema>;

export interface DbConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password?: string;
  readonly ssl: boolean;
  /** Deployed environments authenticate to RDS Proxy with a short-lived IAM token. */
  readonly iamAuth: boolean;
  readonly maxConnections: number;
  readonly region: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new AppError('DEPENDENCY_UNAVAILABLE', `Missing required env var ${name}`, {
      details: { name },
    });
  }
  return value;
}

export function configFromEnv(): DbConfig {
  const iamAuth = process.env.DATABASE_IAM_AUTH === 'true';
  return {
    host: required('DATABASE_HOST'),
    port: Number(process.env.DATABASE_PORT ?? 5432),
    database: required('DATABASE_NAME'),
    user: required('DATABASE_USER'),
    ...(iamAuth ? {} : { password: process.env.DATABASE_PASSWORD ?? '' }),
    ssl: process.env.DATABASE_SSL === 'true',
    iamAuth,
    /**
     * Rule 11: Lambdas reach Aurora through RDS Proxy, never directly. The proxy owns
     * the real pool, so each execution environment keeps only a handful of connections.
     */
    maxConnections: Number(process.env.DATABASE_MAX_CONNECTIONS ?? 5),
    region: process.env.AWS_REGION ?? 'ap-south-1',
  };
}

/**
 * Module scope, so the connection survives across invocations in a warm Lambda
 * execution environment. Creating this per request would defeat RDS Proxy entirely.
 */
let cached: { sql: postgres.Sql; db: Database } | undefined;

function buildClient(config: DbConfig): postgres.Sql {
  const signer = config.iamAuth
    ? new Signer({
        hostname: config.host,
        port: config.port,
        username: config.user,
        region: config.region,
      })
    : undefined;

  return postgres({
    host: config.host,
    port: config.port,
    database: config.database,
    username: config.user,
    /**
     * postgres.js calls this per connection attempt. An IAM token lasts 15 minutes,
     * so it must be minted at connect time rather than captured once at cold start.
     */
    password: signer ? () => signer.getAuthToken() : (config.password ?? ''),
    ssl: config.ssl ? 'require' : false,
    max: config.maxConnections,
    idle_timeout: 30,
    connect_timeout: 10,
    // Lambda freezes between invocations; a prepared-statement cache on a proxied
    // connection goes stale and errors on reuse.
    prepare: false,
    onnotice: () => {},
  });
}

export function getDb(config: DbConfig = configFromEnv()): Database {
  if (!cached) {
    const sql = buildClient(config);
    cached = { sql, db: drizzle(sql, { schema }) };
  }
  return cached.db;
}

/** The raw driver, for the hand-written hybrid search statement in `@catalograil/search`. */
export function getSql(config: DbConfig = configFromEnv()): postgres.Sql {
  if (!cached) getDb(config);
  return cached!.sql;
}

/** Tests and one-shot scripts only. Never call this from a Lambda handler. */
export async function closeDb(): Promise<void> {
  if (cached) {
    await cached.sql.end({ timeout: 5 });
    cached = undefined;
  }
}
