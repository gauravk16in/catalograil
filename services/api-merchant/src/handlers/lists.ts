import { ingestionJobs, productVariants, products, searchableUnits, type Database } from '@catalograil/db';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';

/**
 * The read side of the merchant dashboard.
 *
 * These two lists were the only endpoints the dashboard called that had no implementation
 * at all — every other screen's logic already existed and was simply never routed. The
 * product list is the dashboard's home screen, so "the dashboard is broken" and "this
 * function does not exist" were the same sentence.
 *
 * Both are scoped by merchant id from the caller, never from the request, and neither
 * returns another merchant's rows even given their ids.
 */

/** Serving readiness, derived from the units rather than stored (Block E's status model). */
export type ServingState =
  | 'draft'
  | 'processing'
  | 'indexed'
  | 'partial'
  | 'failed'
  | 'archived';

export interface ProductRow {
  readonly id: string;
  readonly name: string;
  readonly brand: string | null;
  readonly archetype: string;
  readonly status: string;
  readonly variantCount: number;
  readonly unitsIndexed: number;
  readonly unitsTotal: number;
  readonly servingState: ServingState;
  readonly updatedAt: string;
}

export async function listProducts(
  db: Database,
  merchantId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<{ products: ProductRow[]; total: number }> {
  // Capped rather than unbounded: a merchant with 5000 products should not be able to ask
  // the dashboard to render all of them, and the cap is here rather than in the UI because
  // the UI is not the only caller.
  const limit = Math.min(options.limit ?? 50, 200);
  const offset = Math.max(options.offset ?? 0, 0);

  const rows = await db
    .select({
      id: products.id,
      name: products.name,
      brand: products.brand,
      archetype: products.archetype,
      status: products.status,
      updatedAt: products.updatedAt,
    })
    .from(products)
    .where(eq(products.merchantId, merchantId))
    .orderBy(desc(products.updatedAt))
    .limit(limit)
    .offset(offset);

  const [counted] = await db
    .select({ total: sql<number>`COUNT(*)::int` })
    .from(products)
    .where(eq(products.merchantId, merchantId));

  /**
   * Counts come from one grouped query over the page's ids, not from correlated
   * subqueries per row.
   *
   * The subquery version was silently wrong. Drizzle renders an interpolated column
   * unqualified — `${searchableUnits.productId} = ${products.id}` became
   * `WHERE "product_id" = "id"` — and inside the subquery `"id"` resolves to
   * `searchable_units.id` rather than the outer product. It compared a unit id to a
   * product id, matched nothing, and reported every product as still processing: a
   * merchant whose catalogue was fully live would have been told it was not, with no
   * error anywhere. One grouped aggregate is also a single indexed scan instead of three
   * per row.
   */
  const ids = rows.map((row) => row.id);
  const counts = new Map<string, { total: number; indexed: number; failed: number }>();

  if (ids.length > 0) {
    const grouped = await db
      .select({
        productId: searchableUnits.productId,
        total: sql<number>`COUNT(*)::int`,
        indexed: sql<number>`COUNT(*) FILTER (WHERE ${searchableUnits.embeddingStatus} = 'indexed')::int`,
        failed: sql<number>`COUNT(*) FILTER (WHERE ${searchableUnits.embeddingStatus} = 'failed')::int`,
      })
      .from(searchableUnits)
      .where(inArray(searchableUnits.productId, ids))
      .groupBy(searchableUnits.productId);

    for (const row of grouped) {
      if (row.productId) {
        counts.set(row.productId, { total: row.total, indexed: row.indexed, failed: row.failed });
      }
    }
  }

  const variantCounts = new Map<string, number>();
  if (ids.length > 0) {
    const grouped = await db
      .select({ productId: productVariants.productId, count: sql<number>`COUNT(*)::int` })
      .from(productVariants)
      .where(inArray(productVariants.productId, ids))
      .groupBy(productVariants.productId);
    for (const row of grouped) variantCounts.set(row.productId, row.count);
  }

  return {
    products: rows.map((row) => {
      const c = counts.get(row.id) ?? { total: 0, indexed: 0, failed: 0 };
      return {
        id: row.id,
        name: row.name,
        brand: row.brand,
        archetype: row.archetype,
        status: row.status,
        variantCount: variantCounts.get(row.id) ?? 0,
        unitsIndexed: c.indexed,
        unitsTotal: c.total,
        servingState: servingState({
          status: row.status,
          unitsTotal: c.total,
          unitsIndexed: c.indexed,
          unitsFailed: c.failed,
        }),
        updatedAt: row.updatedAt.toISOString(),
      };
    }),
    total: counted?.total ?? 0,
  };
}

/**
 * "Ready to serve" is about the units, not the product row.
 *
 * A merchant asking why their product is not appearing is asking about search, and search
 * reads `searchable_units`. A product can be `active` with zero indexed units — which is
 * exactly the state that produced a full catalogue and an empty search — so status alone
 * would answer the wrong question.
 */
function servingState(row: {
  status: string;
  unitsTotal: number;
  unitsIndexed: number;
  unitsFailed: number;
}): ServingState {
  if (row.status === 'archived') return 'archived';
  if (row.status === 'draft' && row.unitsTotal === 0) return 'draft';
  if (row.unitsTotal === 0) return 'processing';
  if (row.unitsIndexed === row.unitsTotal) return 'indexed';
  if (row.unitsFailed === row.unitsTotal) return 'failed';
  if (row.unitsIndexed > 0) return 'partial';
  return 'processing';
}

export interface IngestionJobRow {
  readonly id: string;
  readonly template: string;
  readonly status: string;
  readonly rowsTotal: number;
  readonly rowsImported: number;
  readonly rowsFailed: number;
  readonly productsCreated: number;
  readonly variantsUpserted: number;
  readonly rejectionReason: string | null;
  readonly errorCount: number;
  readonly createdAt: string;
}

export async function listIngestionJobs(
  db: Database,
  merchantId: string,
  limit = 20,
): Promise<{ jobs: IngestionJobRow[] }> {
  const rows = await db
    .select()
    .from(ingestionJobs)
    .where(eq(ingestionJobs.merchantId, merchantId))
    .orderBy(desc(ingestionJobs.createdAt))
    .limit(Math.min(limit, 100));

  return {
    jobs: rows.map((row) => ({
      id: row.id,
      template: row.template,
      status: row.status,
      rowsTotal: row.rowsTotal,
      rowsImported: row.rowsImported,
      rowsFailed: row.rowsFailed,
      productsCreated: row.productsCreated,
      variantsUpserted: row.variantsUpserted,
      rejectionReason: row.rejectionReason,
      // The rows themselves are not returned: an import can fail thousands of rows and the
      // list view needs the count, not the payload. The error CSV carries the detail.
      errorCount: row.errors?.length ?? 0,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

/** One product with its variants, for the detail view. Scoped by merchant. */
export async function getProduct(
  db: Database,
  merchantId: string,
  productId: string,
): Promise<Record<string, unknown> | null> {
  const [product] = await db
    .select()
    .from(products)
    .where(and(eq(products.id, productId), eq(products.merchantId, merchantId)))
    .limit(1);

  if (!product) return null;

  const variants = await db
    .select()
    .from(productVariants)
    .where(eq(productVariants.productId, productId));

  return {
    ...product,
    // Money crosses the boundary as a string: JSON has no bigint, and rounding paise
    // through a double is exactly the bug rule 13 exists to prevent.
    variants: variants.map((v) => ({
      ...v,
      pricePaise: v.pricePaise?.toString() ?? null,
      mrpPaise: v.mrpPaise?.toString() ?? null,
    })),
  };
}
