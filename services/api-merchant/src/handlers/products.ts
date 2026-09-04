import {
  AppError,
  PHASE_1_ARCHETYPES,
  rupeeStringToPaise,
  type Clock,
  type EnrichmentMessage,
  type Queue,
} from '@catalograil/core';
import { productOptionAxes, productVariants, products, type Database } from '@catalograil/db';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

/**
 * T1.12 — manual product create, update and archive.
 *
 * The CSV path (T1.11) is for a catalogue; this is for the one product a merchant is
 * adding by hand. Both end at the same rows and the same enrichment queue, so a product
 * cannot behave differently depending on how it arrived.
 *
 * Writes are synchronous and return immediately, with enrichment queued behind them: a
 * merchant pressing Save should see their product exist, not wait on a model call that has
 * nothing to do with whether the save succeeded.
 */

/** Money arrives as a decimal string, never a float (rule 13). */
const rupeeString = z
  .string()
  .trim()
  .min(1)
  .refine((value) => /^-?\d+(\.\d{1,2})?$/.test(value.replace(/[₹,\s]/g, '')), {
    message: 'Not a valid rupee amount.',
  });

const variantInputSchema = z.object({
  sku: z.string().trim().min(1).max(120),
  /** `{ "size": "42", "colour": "lilac" }`. Empty for a SIMPLE product. */
  optionValues: z.record(z.string(), z.string()).default({}),
  price: rupeeString,
  mrp: rupeeString.optional(),
  stock: z.number().int().min(0).default(0),
  deliveryDays: z.number().int().min(0).max(90).optional(),
  weightGrams: z.number().int().positive().optional(),
  images: z.array(z.string().url()).max(3).default([]),
});

const optionAxisSchema = z.object({
  name: z.string().trim().min(1).max(80),
  values: z.array(z.string().trim().min(1).max(120)).min(1).max(50),
});

export const createProductSchema = z
  .object({
    externalRef: z.string().trim().min(1).max(120).optional(),
    archetype: z.enum(PHASE_1_ARCHETYPES),
    name: z.string().trim().min(1).max(300),
    brand: z.string().trim().max(200).optional(),
    description: z.string().trim().max(8000).optional(),
    categoryHint: z.string().trim().max(200).optional(),
    attributes: z.record(z.string(), z.unknown()).default({}),
    images: z.array(z.string().url()).max(10).default([]),
    /** VARIANT only. The matrix below must agree with these. */
    optionAxes: z.array(optionAxisSchema).max(3).default([]),
    variants: z.array(variantInputSchema).min(1).max(500),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.archetype === 'VARIANT') {
      if (value.optionAxes.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['optionAxes'],
          message: 'A variant product needs at least one option axis.',
        });
      }

      const axisNames = value.optionAxes.map((axis) => axis.name);
      for (const [index, variant] of value.variants.entries()) {
        const keys = Object.keys(variant.optionValues);
        // Every variant must name every axis, or the matrix has a hole in it and a buyer
        // can select a combination that does not resolve to anything.
        const missing = axisNames.filter((name) => !keys.includes(name));
        if (missing.length > 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['variants', index, 'optionValues'],
            message: `Missing a value for ${missing.join(', ')}.`,
          });
        }
      }
    } else if (value.variants.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['variants'],
        message: 'A simple product has exactly one variant. Use VARIANT for several options.',
      });
    }

    const skus = value.variants.map((variant) => variant.sku);
    if (new Set(skus).size !== skus.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['variants'], message: 'Duplicate SKU.' });
    }
  });

export type CreateProductInput = z.infer<typeof createProductSchema>;

export const updateProductSchema = createProductSchema.innerType().partial().strict();

export interface ProductDeps {
  readonly db: Database;
  readonly enrichmentQueue: Queue<EnrichmentMessage>;
  readonly clock: Clock;
}

export interface ProductWriteResult {
  readonly productId: string;
  readonly variantsCreated: number;
  readonly status: string;
}

/**
 * Creates a product and its whole variant matrix in one transaction.
 *
 * T1.12's acceptance is a 3-axis, 24-combination product created in a single call. It is
 * one transaction rather than a product write followed by variant writes, because a
 * product that exists with half its matrix is worse than one that failed: the merchant
 * would see it listed, and buyers would find combinations that do not resolve.
 */
export async function createProduct(
  deps: ProductDeps,
  merchantId: string,
  body: unknown,
): Promise<ProductWriteResult> {
  const parsed = createProductSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 'The product is not valid.', {
      details: { issues: parsed.error.issues },
    });
  }
  const input = parsed.data;

  const result = await deps.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(products)
      .values({
        merchantId,
        externalRef: input.externalRef ?? null,
        archetype: input.archetype,
        name: input.name,
        brand: input.brand ?? null,
        description: input.description ?? null,
        categoryHint: input.categoryHint ?? null,
        attributes: input.attributes,
        images: input.images,
        // Draft until enrichment and embedding have run, so nothing reaches search
        // un-indexed (same rule the CSV path follows).
        status: 'draft',
      })
      .returning({ id: products.id });

    const productId = inserted[0]!.id;

    if (input.optionAxes.length > 0) {
      await tx.insert(productOptionAxes).values(
        input.optionAxes.map((axis, index) => ({
          productId,
          axisName: axis.name,
          axisValues: axis.values,
          displayOrder: index,
        })),
      );
    }

    await tx.insert(productVariants).values(
      input.variants.map((variant) => ({
        productId,
        sku: variant.sku,
        optionValues: variant.optionValues,
        pricePaise: rupeeStringToPaise(variant.price),
        mrpPaise: variant.mrp ? rupeeStringToPaise(variant.mrp) : null,
        stock: variant.stock,
        deliveryDays: variant.deliveryDays ?? null,
        weightGrams: variant.weightGrams ?? null,
        images: variant.images,
        status: 'active',
      })),
    );

    return { productId, variantsCreated: input.variants.length, status: 'draft' };
  });

  // Queued after the transaction commits, so a consumer can never see an id that is not
  // yet visible on another connection.
  await deps.enrichmentQueue.send({ productId: result.productId, merchantId });

  return result;
}

/**
 * Updates a product in place.
 *
 * Any field the merchant edits is marked `human` in `enrichment_source`, which is what
 * stops the enrichment worker overwriting it on its next run (T1.13). That marking is the
 * whole point of an edit — without it, a correction survives until the next worker pass
 * and then silently reverts.
 */
export async function updateProduct(
  deps: ProductDeps,
  merchantId: string,
  productId: string,
  body: unknown,
): Promise<ProductWriteResult> {
  const parsed = updateProductSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 'The update is not valid.', {
      details: { issues: parsed.error.issues },
    });
  }
  const input = parsed.data;

  const existing = await deps.db
    .select({ id: products.id, enrichmentSource: products.enrichmentSource })
    .from(products)
    .where(and(eq(products.id, productId), eq(products.merchantId, merchantId)))
    .limit(1);

  if (!existing[0]) {
    // Scoped by merchant, so one merchant cannot discover another's product ids by
    // probing for a different error.
    throw new AppError('NOT_FOUND', 'No such product.');
  }

  const source = { ...((existing[0].enrichmentSource as Record<string, string>) ?? {}) };
  for (const field of [
    'attributes',
    'use_cases',
    'target_audience',
    'occasions',
    'keywords',
  ] as const) {
    const key = field === 'attributes' ? 'attributes' : field;
    if (input[camel(field) as keyof typeof input] !== undefined) source[key] = 'human';
  }
  if (input.categoryHint !== undefined) source.category_id = 'human';

  const variantCount = await deps.db.transaction(async (tx) => {
    await tx
      .update(products)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.brand !== undefined ? { brand: input.brand } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.categoryHint !== undefined ? { categoryHint: input.categoryHint } : {}),
        ...(input.attributes !== undefined ? { attributes: input.attributes } : {}),
        ...(input.images !== undefined ? { images: input.images } : {}),
        enrichmentSource: source as Record<string, never>,
        updatedAt: deps.clock.now(),
      })
      .where(eq(products.id, productId));

    if (!input.variants) return 0;

    // Upserted rather than replaced: order_items references variants, so deleting one a
    // buyer has already ordered would orphan their history (same reasoning as T1.11).
    for (const variant of input.variants) {
      await tx
        .insert(productVariants)
        .values({
          productId,
          sku: variant.sku,
          optionValues: variant.optionValues,
          pricePaise: rupeeStringToPaise(variant.price),
          mrpPaise: variant.mrp ? rupeeStringToPaise(variant.mrp) : null,
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
          },
        });
    }
    return input.variants.length;
  });

  await deps.enrichmentQueue.send({ productId, merchantId });

  return { productId, variantsCreated: variantCount, status: 'updated' };
}

/**
 * Soft delete. The T1.16 trigger takes the product out of search; the rows stay, because
 * orders reference them and a buyer's history must not develop holes.
 */
export async function archiveProduct(
  deps: ProductDeps,
  merchantId: string,
  productId: string,
): Promise<{ productId: string; status: string }> {
  const updated = await deps.db
    .update(products)
    .set({ status: 'archived', updatedAt: deps.clock.now() })
    .where(and(eq(products.id, productId), eq(products.merchantId, merchantId)))
    .returning({ id: products.id });

  if (!updated[0]) throw new AppError('NOT_FOUND', 'No such product.');
  return { productId, status: 'archived' };
}

/** `use_cases` → `useCases`, matching the schema's field names. */
function camel(snake: string): string {
  return snake.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
}
