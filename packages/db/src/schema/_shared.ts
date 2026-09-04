import { sql } from 'drizzle-orm';
import { customType, timestamp } from 'drizzle-orm/pg-core';

/**
 * `ltree` — hierarchical category paths. Drizzle has no built-in type for it.
 * Enables `category_path <@ 'apparel.shirts'` containment in the search filter (T1.17).
 */
export const ltree = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'ltree';
  },
});

/**
 * `tsvector` — the lexical channel of hybrid search. Always a generated column;
 * never written directly.
 */
export const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tsvector';
  },
});

/** All timestamps are `timestamptz`, stored UTC, rendered IST at the edge (conventions §9). */
export const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).defaultNow().notNull();
export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true }).defaultNow().notNull();
export const tstz = (name: string) => timestamp(name, { withTimezone: true });

/**
 * Render a string union as a SQL `IN` list, so a CHECK constraint is generated from
 * the same constant the TypeScript types come from. Drift between the two becomes
 * impossible rather than merely unlikely.
 */
export function inList(values: readonly string[]) {
  return sql.raw(values.map((v) => `'${v.replaceAll("'", "''")}'`).join(', '));
}
