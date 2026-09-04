import {
  ARCHETYPES,
  PRODUCT_STATUSES,
  type Archetype,
  type EnrichmentSource,
} from '@catalograil/core';
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { adapters } from './phase3.js';
import { createdAt, inList, ltree, updatedAt } from './_shared.js';
import { merchants } from './merchants.js';

/**
 * Auto-growing taxonomy. The enrichment worker creates leaves it is confident about
 * and parks the rest at `pending_review` for a human (T1.13).
 */
export const categories = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Self-reference needs the explicit AnyPgColumn annotation, or the inferred type
    // of `categories` becomes circular.
    parentId: uuid('parent_id').references((): AnyPgColumn => categories.id),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    /** Materialised path, e.g. `apparel.shirts.formal`. Queried with `<@` in search. */
    path: ltree('path'),
    /** Attributes expected on products in this leaf, used to steer enrichment. */
    attributeSchema: jsonb('attribute_schema').$type<Record<string, unknown>>(),
    reviewStatus: text('review_status').default('approved').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('categories_path_idx').using('gist', t.path),
    index('categories_parent_idx').on(t.parentId),
    check(
      'categories_review_status_check',
      sql`${t.reviewStatus} IN ('approved', 'pending_review')`,
    ),
  ],
);

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    /**
     * The merchant's own identifier for this product. Not in context §6's column list,
     * but its `unique (merchant_id, external_ref)` constraint requires it, and T1.11
     * matches re-uploads on it so a repeated CSV updates instead of duplicating.
     */
    externalRef: text('external_ref'),
    archetype: text('archetype').$type<Archetype>().notNull(),
    name: text('name').notNull(),
    brand: text('brand'),
    description: text('description'),
    categoryId: uuid('category_id').references(() => categories.id),
    /**
     * The merchant's own free-text category from the CSV (`category_hint`) or the product
     * form. Kept alongside `category_id` rather than replaced by it: ingestion only
     * resolves a hint that already matches the taxonomy, and enrichment (T1.13) reads the
     * unresolved text as a signal when deciding where the product belongs.
     */
    categoryHint: text('category_hint'),
    attributes: jsonb('attributes').$type<Record<string, unknown>>().default({}).notNull(),
    useCases: text('use_cases').array(),
    targetAudience: text('target_audience').array(),
    occasions: text('occasions').array(),
    keywords: text('keywords').array(),
    /**
     * Per-field provenance: `{ "use_cases": "human", "keywords": "ai" }`.
     * The enrichment worker must never overwrite a field marked `human` (T1.13).
     */
    enrichmentSource: jsonb('enrichment_source')
      .$type<Record<string, EnrichmentSource>>()
      .default({})
      .notNull(),
    images: text('images').array(),
    status: text('status').default('draft').notNull(),

    // ── LIVE_PRICED / BOOKABLE / QUOTE only. Unused until Phase 3. ──────────────
    routeOrScope: text('route_or_scope'),
    priceRangeHint: text('price_range_hint'),
    adapterId: uuid('adapter_id').references(() => adapters.id),
    rfqFields: jsonb('rfq_fields').$type<Record<string, unknown>>(),
    typicalTurnaroundHours: integer('typical_turnaround_hours'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('products_merchant_external_ref_key').on(t.merchantId, t.externalRef),
    index('products_merchant_status_idx').on(t.merchantId, t.status),
    index('products_category_idx').on(t.categoryId),
    check('products_archetype_check', sql`${t.archetype} IN (${inList(ARCHETYPES)})`),
    check('products_status_check', sql`${t.status} IN (${inList(PRODUCT_STATUSES)})`),
  ],
);

export const productVariants = pgTable(
  'product_variants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    sku: text('sku').notNull(),
    /** The point on each axis, e.g. `{"size":"42","colour":"lilac"}`. */
    optionValues: jsonb('option_values').$type<Record<string, string>>().notNull(),
    /** Rule 13: money is bigint paise, never a float. */
    pricePaise: bigint('price_paise', { mode: 'bigint' }),
    mrpPaise: bigint('mrp_paise', { mode: 'bigint' }),
    stock: integer('stock').default(0).notNull(),
    deliveryDays: integer('delivery_days'),
    weightGrams: integer('weight_grams'),
    dimensionsCm: jsonb('dimensions_cm').$type<{ l?: number; w?: number; h?: number }>(),
    images: text('images').array(),
    status: text('status').default('active').notNull(),
  },
  (t) => [
    unique('product_variants_product_sku_key').on(t.productId, t.sku),
    index('product_variants_product_idx').on(t.productId),
    check('product_variants_price_positive', sql`${t.pricePaise} IS NULL OR ${t.pricePaise} > 0`),
    check('product_variants_stock_non_negative', sql`${t.stock} >= 0`),
  ],
);

/** The axes a VARIANT product is sold along, in display order. */
export const productOptionAxes = pgTable(
  'product_option_axes',
  {
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    axisName: text('axis_name').notNull(),
    axisValues: text('axis_values').array().notNull(),
    displayOrder: integer('display_order').default(0).notNull(),
  },
  (t) => [primaryKey({ columns: [t.productId, t.axisName] })],
);
