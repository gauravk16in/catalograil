import {
  ARCHETYPES,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_STATUSES,
  MERCHANT_STATUSES,
  UNIT_TYPES,
  type Archetype,
  type EmbeddingStatus,
  type UnitType,
} from '@catalograil/core';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import { products, productVariants } from './catalog.js';
import { inList, ltree, tsvector, updatedAt } from './_shared.js';

/**
 * The single table every search hits. Denormalised on purpose: one filtered scan and
 * three vector probes, no joins.
 *
 * Two rules govern writes here:
 *   - Only the embedding worker writes the search columns (never-do #2). API handlers
 *     do not touch this table.
 *   - The denormalised filterables are kept current by triggers on the source tables
 *     (T1.16), because a stock change must vanish from results within a second and a
 *     queue hop cannot promise that.
 *
 * And one on reads: never `SELECT *` (never-do #1) — three 1024-wide vectors come back.
 */
export const searchableUnits = pgTable(
  'searchable_units',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** D6: the variant is the searchable unit, not the product. */
    unitType: text('unit_type').$type<UnitType>().notNull(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id').references(() => productVariants.id, { onDelete: 'cascade' }),
    merchantId: uuid('merchant_id').notNull(),
    archetype: text('archetype').$type<Archetype>().notNull(),

    // ── Denormalised filterables. Every one of these is a hard WHERE in T1.17, ────
    // ── never a score penalty (rule 5). ──────────────────────────────────────────
    categoryId: uuid('category_id'),
    categoryPath: ltree('category_path'),
    /** Null for LIVE_PRICED and QUOTE — their price is not known until query time. */
    pricePaise: bigint('price_paise', { mode: 'bigint' }),
    inStock: boolean('in_stock').default(false).notNull(),
    deliveryDays: integer('delivery_days'),
    attributes: jsonb('attributes').$type<Record<string, unknown>>().default({}).notNull(),
    merchantStatus: text('merchant_status').notNull(),
    trustScore: numeric('trust_score', { precision: 4, scale: 3 }),

    // ── Search ───────────────────────────────────────────────────────────────────
    canonicalText: text('canonical_text').notNull(),
    /** sha256 of canonical_text. Rule 9: re-embed only when this changes. */
    contentHash: text('content_hash').notNull(),
    tsv: tsvector('tsv').generatedAlwaysAs(sql`to_tsvector('english', canonical_text)`),
    /**
     * D5 produces int8 embeddings, but pgvector has no int8 vector type — `vector` is
     * float32 and holds the int8 values exactly. If MODELS.md (T1.2) reports a width
     * other than 1024, change EMBEDDING_DIMENSIONS before the first migration:
     * altering a pgvector column after the HNSW indexes exist rebuilds the whole table.
     */
    vSemantic: vector('v_semantic', { dimensions: EMBEDDING_DIMENSIONS }),
    /** Use cases and audience only — matches "something for a beach wedding". */
    vIntent: vector('v_intent', { dimensions: EMBEDDING_DIMENSIONS }),
    /** Primary image. Null when the image failed to embed; the row still indexes. */
    vVisual: vector('v_visual', { dimensions: EMBEDDING_DIMENSIONS }),
    embeddingVersion: text('embedding_version').default('v1').notNull(),
    embeddingStatus: text('embedding_status').$type<EmbeddingStatus>().default('pending').notNull(),

    updatedAt: updatedAt(),
  },
  (t) => [
    index('searchable_units_semantic_hnsw')
      .using('hnsw', t.vSemantic.op('vector_cosine_ops'))
      .with({ m: 16, ef_construction: 64 }),
    index('searchable_units_visual_hnsw')
      .using('hnsw', t.vVisual.op('vector_cosine_ops'))
      .with({ m: 16, ef_construction: 64 }),
    index('searchable_units_intent_hnsw')
      .using('hnsw', t.vIntent.op('vector_cosine_ops'))
      .with({ m: 16, ef_construction: 64 }),
    index('searchable_units_tsv_gin').using('gin', t.tsv),
    index('searchable_units_attributes_gin').using('gin', t.attributes.op('jsonb_path_ops')),
    index('searchable_units_category_path_gist').using('gist', t.categoryPath),
    // Covers the `filtered` CTE in T1.17.
    index('searchable_units_filter_idx').on(t.merchantStatus, t.inStock, t.pricePaise),
    // The embedding worker's backlog scan.
    index('searchable_units_embedding_status_idx').on(t.embeddingStatus, t.updatedAt),
    index('searchable_units_product_idx').on(t.productId),
    index('searchable_units_variant_idx').on(t.variantId),
    index('searchable_units_merchant_idx').on(t.merchantId),

    check('searchable_units_unit_type_check', sql`${t.unitType} IN (${inList(UNIT_TYPES)})`),
    check('searchable_units_archetype_check', sql`${t.archetype} IN (${inList(ARCHETYPES)})`),
    check(
      'searchable_units_merchant_status_check',
      sql`${t.merchantStatus} IN (${inList(MERCHANT_STATUSES)})`,
    ),
    check(
      'searchable_units_embedding_status_check',
      sql`${t.embeddingStatus} IN (${inList(EMBEDDING_STATUSES)})`,
    ),
    // A variant-typed unit must name its variant; a product-typed one must not.
    check(
      'searchable_units_variant_consistency',
      sql`(${t.unitType} = 'variant' AND ${t.variantId} IS NOT NULL)
          OR (${t.unitType} <> 'variant' AND ${t.variantId} IS NULL)`,
    ),
  ],
);
