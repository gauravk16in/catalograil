/**
 * Applies pending migrations. Forward-only (conventions §9) — drizzle-kit generates
 * no down migrations and none should be hand-written.
 *
 *   DATABASE_URL=postgres://... pnpm db:migrate
 */
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

const sql = postgres(url, { max: 1, onnotice: () => {} });

try {
  // The vector, ltree and pg_trgm extensions must exist before the schema that uses
  // them. In deployed environments the data stack creates these on first boot (T1.3);
  // doing it here too keeps a local database a single command away from usable.
  await sql.unsafe(`
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE EXTENSION IF NOT EXISTS ltree;
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
  `);

  await migrate(drizzle(sql), { migrationsFolder: './migrations' });
  console.log('Migrations applied.');
} finally {
  await sql.end();
}
