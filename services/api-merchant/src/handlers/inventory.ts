import { AppError, type Clock } from '@catalograil/core';
import { productVariants, products, type Database } from '@catalograil/db';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

/**
 * S6.2 — inventory as its own screen.
 *
 * Adjusting stock is a different job from editing a product: it happens daily, across many
 * products at once, and by someone who may not be the person who wrote the descriptions.
 * Making them edit a product form to change one number is how stock counts go stale, and a
 * stale count is what produces an order a merchant cannot fulfil.
 */

export interface VariantRow {
  readonly variantId: string;
  readonly productId: string;
  readonly productName: string;
  readonly sku: string;
  readonly optionValues: Record<string, string>;
  readonly stock: number;
  readonly pricePaise: string | null;
  readonly deliveryDays: number | null;
  readonly status: string;
  readonly inStock: boolean;
}

export async function listInventory(
  db: Database,
  merchantId: string,
  options: { lowStockBelow?: number; outOfStockOnly?: boolean; limit?: number } = {},
): Promise<{ variants: VariantRow[]; total: number }> {
  const limit = Math.min(options.limit ?? 200, 500);

  const conditions = [eq(products.merchantId, merchantId), sql`${products.status} <> 'archived'`];
  if (options.outOfStockOnly) conditions.push(sql`${productVariants.stock} = 0`);
  else if (options.lowStockBelow != null) {
    conditions.push(sql`${productVariants.stock} < ${options.lowStockBelow}`);
  }

  const rows = await db
    .select({
      variantId: productVariants.id,
      productId: products.id,
      productName: products.name,
      sku: productVariants.sku,
      optionValues: productVariants.optionValues,
      stock: productVariants.stock,
      pricePaise: productVariants.pricePaise,
      deliveryDays: productVariants.deliveryDays,
      status: productVariants.status,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(and(...conditions))
    .orderBy(asc(products.name), asc(productVariants.sku))
    .limit(limit);

  return {
    variants: rows.map((row) => ({
      variantId: row.variantId,
      productId: row.productId,
      productName: row.productName,
      sku: row.sku,
      optionValues: (row.optionValues ?? {}) as Record<string, string>,
      stock: row.stock,
      // Money crosses the boundary as a string; JSON has no bigint (rule 13).
      pricePaise: row.pricePaise?.toString() ?? null,
      deliveryDays: row.deliveryDays,
      status: row.status,
      inStock: row.stock > 0,
    })),
    total: rows.length,
  };
}

const stockUpdateSchema = z.object({
  updates: z
    .array(
      z.object({
        sku: z.string().trim().min(1).max(120),
        stock: z.number().int().min(0).max(1_000_000),
      }),
    )
    .min(1)
    .max(1000),
});

export interface InventoryDeps {
  readonly db: Database;
  readonly clock: Clock;
}

/**
 * Bulk stock update, by SKU.
 *
 * SKU rather than variant id, because that is what a merchant has in their own system and
 * in the CSV they will paste from. Ids are ours; SKUs are theirs.
 *
 * Rule 9 matters here and is why this writes only `stock`: stock is denormalised into
 * `searchable_units` by the T1.16 trigger and never contributes to `content_hash`, so a
 * thousand stock updates re-embed nothing. Setting stock to 0 removes the variant from
 * search within the transaction.
 */
export async function updateStock(
  deps: InventoryDeps,
  merchantId: string,
  body: unknown,
): Promise<{ updated: number; unknownSkus: string[] }> {
  const parsed = stockUpdateSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 'Each update needs a sku and a stock count.', {
      details: { issues: parsed.error.issues },
    });
  }

  const skus = parsed.data.updates.map((u) => u.sku);

  // Resolved through the merchant's own products, so a SKU that belongs to someone else is
  // reported as unknown rather than silently updated.
  const owned = await deps.db
    .select({ id: productVariants.id, sku: productVariants.sku })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(and(eq(products.merchantId, merchantId), inArray(productVariants.sku, skus)));

  const bySku = new Map(owned.map((row) => [row.sku, row.id]));
  const unknownSkus = skus.filter((sku) => !bySku.has(sku));

  let updated = 0;
  await deps.db.transaction(async (tx) => {
    for (const update of parsed.data.updates) {
      const id = bySku.get(update.sku);
      if (!id) continue;
      await tx
        .update(productVariants)
        .set({ stock: update.stock })
        .where(eq(productVariants.id, id));
      updated++;
    }
  });

  return { updated, unknownSkus };
}
