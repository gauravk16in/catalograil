import type { ParsedProduct } from '@catalograil/core';
import { categories, productOptionAxes, productVariants, products } from '@catalograil/db';
import { and, eq, sql } from 'drizzle-orm';
import type { PgTransaction } from 'drizzle-orm/pg-core';

/**
 * Writes one parsed product and its variants. Called inside a transaction per product, so
 * a product either lands whole or not at all — a product row with half its variants is
 * worse than a product that failed and got reported.
 *
 * Matching is on `(merchant_id, external_ref)`, which is what makes a re-upload an update
 * rather than a duplicate (T1.11 acceptance).
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- drizzle's tx type is not exported in a usable form */
export type Tx = PgTransaction<any, any, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface UpsertOutcome {
  readonly productId: string;
  readonly created: boolean;
  readonly variantsUpserted: number;
}

export async function upsertProduct(
  tx: Tx,
  merchantId: string,
  product: ParsedProduct,
): Promise<UpsertOutcome> {
  const existing = await tx
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.merchantId, merchantId), eq(products.externalRef, product.externalRef)))
    .limit(1);

  const previous = existing[0];
  const categoryId = product.categoryHint ? await resolveCategory(tx, product.categoryHint) : null;

  const shared = {
    name: product.name,
    brand: product.brand ?? null,
    description: product.description ?? null,
    categoryHint: product.categoryHint ?? null,
    images: product.images,
    ...(categoryId ? { categoryId } : {}),
  };

  let productId: string;
  if (previous) {
    /**
     * Note what is NOT set here: `status`.
     *
     * T1.11 says to set products.status = 'draft' after import. Applied to an update that
     * would pull a live product out of the catalogue every time a merchant re-uploaded a
     * price change, and it would stay invisible until enrichment and embedding finished.
     * So 'draft' applies to newly created products only; an existing product keeps the
     * status it had, and re-embedding is driven by content_hash (rule 9) instead.
     */
    await tx
      .update(products)
      .set({ ...shared, updatedAt: new Date() })
      .where(eq(products.id, previous.id));
    productId = previous.id;
  } else {
    const inserted = await tx
      .insert(products)
      .values({
        merchantId,
        externalRef: product.externalRef,
        archetype: product.archetype,
        status: 'draft',
        ...shared,
      })
      .returning({ id: products.id });
    productId = inserted[0]!.id;
  }

  // Axes are replaced wholesale: a merchant who drops an axis from the file means it,
  // and the axis rows carry no history worth preserving.
  await tx.delete(productOptionAxes).where(eq(productOptionAxes.productId, productId));
  if (product.optionAxes.length > 0) {
    await tx.insert(productOptionAxes).values(
      product.optionAxes.map((axis, index) => ({
        productId,
        axisName: axis.name,
        axisValues: axis.values,
        displayOrder: index,
      })),
    );
  }

  /**
   * Variants are upserted, never deleted.
   *
   * A variant that disappears from a re-uploaded file is left alone rather than removed,
   * because `order_items.variant_id` references it — deleting one would either fail or
   * orphan a buyer's order history. Withdrawing a variant is therefore not expressible
   * through a re-upload in Phase 1; it is an explicit action in the dashboard (T1.23).
   */
  for (const variant of product.variants) {
    await tx
      .insert(productVariants)
      .values({
        productId,
        sku: variant.sku,
        optionValues: variant.optionValues,
        pricePaise: variant.pricePaise,
        mrpPaise: variant.mrpPaise ?? null,
        stock: variant.stock,
        deliveryDays: variant.deliveryDays ?? null,
        weightGrams: variant.weightGrams ?? null,
        images: variant.images,
        status: 'active',
      })
      .onConflictDoUpdate({
        target: [productVariants.productId, productVariants.sku],
        set: {
          optionValues: sql`excluded.option_values`,
          pricePaise: sql`excluded.price_paise`,
          mrpPaise: sql`excluded.mrp_paise`,
          stock: sql`excluded.stock`,
          deliveryDays: sql`excluded.delivery_days`,
          weightGrams: sql`excluded.weight_grams`,
          images: sql`excluded.images`,
          status: sql`excluded.status`,
        },
      });
  }

  return { productId, created: !previous, variantsUpserted: product.variants.length };
}

/**
 * Best-effort match of the merchant's free-text hint against the existing taxonomy.
 *
 * Deliberately does not create a category. Growing the taxonomy is the enrichment worker's
 * job (T1.13), which decides with a confidence score and can route a doubtful one to
 * review; letting a CSV cell create categories would fill the tree with typos. An
 * unmatched hint stays on the product for enrichment to read.
 */
async function resolveCategory(tx: Tx, hint: string): Promise<string | null> {
  const normalised = hint.trim().toLowerCase();
  if (!normalised) return null;

  const slug = normalised.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const match = await tx
    .select({ id: categories.id })
    .from(categories)
    .where(sql`${categories.slug} = ${slug} OR lower(${categories.name}) = ${normalised}`)
    .limit(1);

  return match[0]?.id ?? null;
}
