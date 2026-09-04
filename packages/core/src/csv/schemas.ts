import { z } from 'zod';
import { rupeeStringToPaise } from '../money/index.js';
import { MAX_IMAGE_COLUMNS, MAX_OPTION_AXES } from './templates.js';

/**
 * Row-level schemas. Every CSV cell arrives as a string, so each of these parses and
 * narrows rather than merely checking.
 *
 * Money goes through `rupeeStringToPaise` (rule 13) — a price never becomes a float on
 * its way in, not even briefly.
 */

const MAX_NAME_LENGTH = 300;
const MAX_DESCRIPTION_LENGTH = 8_000;
const MAX_REF_LENGTH = 120;

/** Trimmed, and empty string treated as absent — merchants leave cells blank, not null. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `must be ${max} characters or fewer`)
    .transform((v) => (v.length === 0 ? undefined : v))
    .optional();

const requiredText = (label: string, max: number) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .max(max, `${label} must be ${max} characters or fewer`);

/** Amounts land as bigint paise or the row fails. Never a float, never a rounded number. */
const paise = (label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .transform((value, ctx) => {
      try {
        return rupeeStringToPaise(value);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} is not a valid amount: "${value}"`,
        });
        return z.NEVER;
      }
    });

const optionalPaise = (label: string) =>
  z
    .string()
    .trim()
    .transform((value, ctx) => {
      if (value.length === 0) return undefined;
      try {
        return rupeeStringToPaise(value);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} is not a valid amount: "${value}"`,
        });
        return z.NEVER;
      }
    });

const optionalInteger = (label: string, { min = 0 }: { min?: number } = {}) =>
  z
    .string()
    .trim()
    .transform((value, ctx) => {
      if (value.length === 0) return undefined;
      if (!/^-?\d+$/.test(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} must be a whole number, got "${value}"`,
        });
        return z.NEVER;
      }
      const parsed = Number(value);
      if (parsed < min) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} must be ${min} or more` });
        return z.NEVER;
      }
      return parsed;
    });

/**
 * Only http(s) is accepted. A `file://` or bare path would pass a generic URL check and
 * then fail much later, in the image embedding worker, where the merchant never sees it.
 */
const imageUrl = z
  .string()
  .trim()
  .transform((value, ctx) => {
    if (value.length === 0) return undefined;
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `not a valid URL: "${value}"` });
      return z.NEVER;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `image URLs must be http or https, got "${parsed.protocol}//"`,
      });
      return z.NEVER;
    }
    return parsed.toString();
  });

const imageColumns = Object.fromEntries(
  Array.from({ length: MAX_IMAGE_COLUMNS }, (_, i) => [`image_url_${i + 1}`, imageUrl]),
) as Record<`image_url_${number}`, typeof imageUrl>;

const axisColumns = Object.fromEntries(
  Array.from({ length: MAX_OPTION_AXES }, (_, i) => [
    [`option_axis_${i + 1}_name`, optionalText(80)],
    [`option_axis_${i + 1}_value`, optionalText(120)],
  ]).flat() as [string, z.ZodTypeAny][],
);

const sharedColumns = {
  external_ref: requiredText('external_ref', MAX_REF_LENGTH),
  name: requiredText('name', MAX_NAME_LENGTH),
  brand: optionalText(200),
  description: optionalText(MAX_DESCRIPTION_LENGTH),
  category_hint: optionalText(200),
  price: paise('price'),
  mrp: optionalPaise('mrp'),
  stock: optionalInteger('stock'),
  delivery_days: optionalInteger('delivery_days'),
};

/**
 * Checks that need more than one column, applied to both templates.
 *
 * `price > 0` and "at least one image" are named in T1.10 as file-level checks, but they
 * are decidable from a single row, so they run here — that way a bad row is reported with
 * its own row number instead of as a vague complaint about the file.
 */
function refineShared(
  row: { price: bigint; mrp?: bigint | undefined } & Record<string, unknown>,
  ctx: z.RefinementCtx,
): void {
  if (row.price <= 0n) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['price'],
      message: 'price must be greater than 0',
    });
  }
  if (row.mrp !== undefined && row.mrp < row.price) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['mrp'],
      message: 'mrp must be greater than or equal to price',
    });
  }

  const images = Array.from(
    { length: MAX_IMAGE_COLUMNS },
    (_, i) => row[`image_url_${i + 1}`],
  ).filter((v): v is string => typeof v === 'string' && v.length > 0);
  if (images.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['image_url_1'],
      message: 'at least one image URL is required',
    });
  }
}

export const simpleRowSchema = z
  .object({
    ...sharedColumns,
    weight_grams: optionalInteger('weight_grams', { min: 1 }),
    ...imageColumns,
  })
  .superRefine(refineShared);

export const variantRowSchema = z
  .object({
    ...sharedColumns,
    ...axisColumns,
    sku: requiredText('sku', MAX_REF_LENGTH),
    ...imageColumns,
  })
  .superRefine((row, ctx) => {
    refineShared(row as never, ctx);

    // An axis is a name/value pair. Half of one is a typo, not a declaration.
    let declaredAxes = 0;
    for (let i = 1; i <= MAX_OPTION_AXES; i++) {
      const name = row[`option_axis_${i}_name` as keyof typeof row] as string | undefined;
      const value = row[`option_axis_${i}_value` as keyof typeof row] as string | undefined;
      if (name && !value) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [`option_axis_${i}_value`],
          message: `option_axis_${i}_name is "${name}" but option_axis_${i}_value is empty`,
        });
      }
      if (!name && value) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [`option_axis_${i}_name`],
          message: `option_axis_${i}_value is "${value}" but option_axis_${i}_name is empty`,
        });
      }
      if (name && value) declaredAxes++;
    }

    if (declaredAxes === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['option_axis_1_name'],
        message: 'a variant row needs at least one option axis, e.g. option_axis_1_name "size"',
      });
    }
  });

export type SimpleRow = z.infer<typeof simpleRowSchema>;
export type VariantRow = z.infer<typeof variantRowSchema>;
