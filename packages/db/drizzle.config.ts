import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit runs locally and in CI, never inside a Lambda, so it uses a plain
 * connection string rather than the IAM-signed RDS Proxy path in src/client.ts.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './.drizzle/schema.cjs',
  out: './migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/catalograil',
  },
  // Extensions are created by the data stack on first boot (T1.3), not by a migration.
  extensionsFilters: ['postgis'],
  verbose: true,
  strict: true,
});
