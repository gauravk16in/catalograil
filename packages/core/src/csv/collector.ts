import type { ZodIssue } from 'zod';
import { MAX_STORED_INGESTION_ERRORS } from '../constants/index.js';
import type { Archetype } from '../constants/index.js';
import { simpleRowSchema, variantRowSchema } from './schemas.js';
import { MAX_IMAGE_COLUMNS, MAX_OPTION_AXES, type CsvTemplate } from './templates.js';

/**
 * The row-by-row half of catalogue validation, split out so the whole-file validator
 * (T1.10) and the streaming ingestion worker (T1.11) share one implementation of the
 * collapse rules. Two copies of "rows sharing an external_ref must agree" would drift,
 * and the merchant would get different verdicts depending on how they uploaded.
 *
 * Rows are fed in file order with their own line numbers, so the caller decides where
 * they come from — a parsed array, or a stream that never holds the file in memory.
 */

export interface CsvRowError {
  /** Spreadsheet line number, header being line 1. */
  readonly row: number;
  readonly column?: string;
  readonly message: string;
}

export interface ParsedVariant {
  readonly sku: string;
  readonly optionValues: Record<string, string>;
  readonly pricePaise: bigint;
  readonly mrpPaise?: bigint;
  readonly stock: number;
  readonly deliveryDays?: number;
  readonly weightGrams?: number;
  readonly images: string[];
  /** The line this variant came from, for error reporting further down the pipeline. */
  readonly sourceRow: number;
}

export interface ParsedProduct {
  readonly externalRef: string;
  readonly archetype: Archetype;
  readonly name: string;
  readonly brand?: string;
  readonly description?: string;
  readonly categoryHint?: string;
  readonly images: string[];
  /** Declared axes in first-seen order, each with its values in first-seen order. */
  readonly optionAxes: { name: string; values: string[] }[];
  readonly variants: ParsedVariant[];
  readonly sourceRow: number;
}

export interface CollectorOptions {
  /** Cap on *stored* errors. Everything is still counted. */
  readonly maxErrors?: number;
  /**
   * Refuses a file with more distinct products than this.
   *
   * Streaming keeps the raw file out of memory, but the collapsed products necessarily
   * accumulate — a row for a given `external_ref` can appear anywhere in the file, so no
   * product is provably complete until the last row is read. Peak memory is therefore
   * proportional to distinct products rather than file size, and this is the ceiling on
   * it. A merchant with a genuinely larger catalogue should be split across files.
   */
  readonly maxProducts?: number;
}

const DEFAULT_MAX_PRODUCTS = 20_000;

export class CatalogRowCollector {
  private readonly template: CsvTemplate;
  private readonly maxErrors: number;
  private readonly maxProducts: number;
  private readonly byRef = new Map<string, ParsedProduct>();
  private readonly seenSkus = new Map<string, number>();
  private readonly collectedErrors: CsvRowError[] = [];
  private totalErrors = 0;
  private rowsSeen = 0;
  private rowsAccepted = 0;
  private overflowed = false;

  constructor(template: CsvTemplate, options: CollectorOptions = {}) {
    this.template = template;
    this.maxErrors = options.maxErrors ?? MAX_STORED_INGESTION_ERRORS;
    this.maxProducts = options.maxProducts ?? DEFAULT_MAX_PRODUCTS;
  }

  get products(): ParsedProduct[] {
    return [...this.byRef.values()];
  }

  get errors(): readonly CsvRowError[] {
    return this.collectedErrors;
  }

  get errorCount(): number {
    return this.totalErrors;
  }

  get rowsTotal(): number {
    return this.rowsSeen;
  }

  get rowsValid(): number {
    return this.rowsAccepted;
  }

  /** True once `maxProducts` was exceeded; the caller should fail the job. */
  get productLimitExceeded(): boolean {
    return this.overflowed;
  }

  /** Feeds one data row. `rowNumber` is the spreadsheet line, header being line 1. */
  addRow(record: Record<string, string>, rowNumber: number): void {
    this.rowsSeen++;

    const schema = this.template === 'simple' ? simpleRowSchema : variantRowSchema;
    const parsed = schema.safeParse(record);

    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        this.addError(rowNumber, issue.message, columnOf(issue));
      }
      return;
    }

    const row = parsed.data as Record<string, unknown>;
    const externalRef = row.external_ref as string;
    const images = collectImages(row);

    if (this.template === 'variant') {
      const sku = row.sku as string;
      const firstSeen = this.seenSkus.get(sku);
      if (firstSeen !== undefined) {
        this.addError(
          rowNumber,
          `duplicate SKU "${sku}", already used on line ${firstSeen}`,
          'sku',
        );
        return;
      }
      this.seenSkus.set(sku, rowNumber);
    }

    const optionValues = this.template === 'variant' ? collectOptionValues(row) : {};

    let product = this.byRef.get(externalRef);
    if (!product) {
      if (this.byRef.size >= this.maxProducts) {
        this.overflowed = true;
        this.addError(
          rowNumber,
          `this file contains more than ${this.maxProducts} products. Split it into smaller files.`,
          'external_ref',
        );
        return;
      }
      product = {
        externalRef,
        archetype: this.template === 'simple' ? 'SIMPLE' : 'VARIANT',
        name: row.name as string,
        ...(row.brand ? { brand: row.brand as string } : {}),
        ...(row.description ? { description: row.description as string } : {}),
        ...(row.category_hint ? { categoryHint: row.category_hint as string } : {}),
        images: [...images],
        optionAxes: [],
        variants: [],
        sourceRow: rowNumber,
      };
      this.byRef.set(externalRef, product);
    } else if (this.template === 'simple') {
      this.addError(
        rowNumber,
        `external_ref "${externalRef}" already appears on line ${product.sourceRow}. ` +
          'Simple products take one row each — use the variant template for products sold in several options.',
        'external_ref',
      );
      return;
    } else {
      // Rows sharing an external_ref describe one product, so the product-level columns
      // must agree. The first occurrence wins and the conflict is reported, rather than a
      // later row silently rewriting a name the merchant already saw accepted.
      const conflict = firstConflict(product, row);
      if (conflict) {
        this.addError(
          rowNumber,
          `${conflict.column} is "${conflict.found}" here but "${conflict.expected}" on line ${product.sourceRow}, ` +
            'where this external_ref first appears. Rows sharing an external_ref must describe the same product.',
          conflict.column,
        );
        return;
      }
      for (const image of images) {
        if (!product.images.includes(image)) product.images.push(image);
      }
    }

    if (this.template === 'variant') {
      const axisConflict = mergeAxes(product, optionValues);
      if (axisConflict) {
        this.addError(rowNumber, axisConflict, 'option_axis_1_name');
        return;
      }

      const duplicate = product.variants.find((v) => sameOptions(v.optionValues, optionValues));
      if (duplicate) {
        this.addError(
          rowNumber,
          `this option combination (${describeOptions(optionValues)}) is already defined on line ${duplicate.sourceRow}`,
          'option_axis_1_value',
        );
        return;
      }
    }

    product.variants.push({
      sku: (row.sku as string | undefined) ?? externalRef,
      optionValues,
      pricePaise: row.price as bigint,
      ...(row.mrp !== undefined ? { mrpPaise: row.mrp as bigint } : {}),
      stock: (row.stock as number | undefined) ?? 0,
      ...(row.delivery_days !== undefined ? { deliveryDays: row.delivery_days as number } : {}),
      ...(row.weight_grams !== undefined ? { weightGrams: row.weight_grams as number } : {}),
      images,
      sourceRow: rowNumber,
    });
    this.rowsAccepted++;
  }

  private addError(row: number, message: string, column?: string): void {
    this.totalErrors++;
    if (this.collectedErrors.length < this.maxErrors) {
      this.collectedErrors.push({ row, ...(column ? { column } : {}), message });
    }
  }
}

// ─── Collapse helpers ─────────────────────────────────────────────────────────────

function collectImages(row: Record<string, unknown>): string[] {
  const images: string[] = [];
  for (let i = 1; i <= MAX_IMAGE_COLUMNS; i++) {
    const value = row[`image_url_${i}`];
    if (typeof value === 'string' && value.length > 0 && !images.includes(value))
      images.push(value);
  }
  return images;
}

function collectOptionValues(row: Record<string, unknown>): Record<string, string> {
  const values: Record<string, string> = {};
  for (let i = 1; i <= MAX_OPTION_AXES; i++) {
    const name = row[`option_axis_${i}_name`];
    const value = row[`option_axis_${i}_value`];
    if (typeof name === 'string' && typeof value === 'string' && name && value) {
      values[name] = value;
    }
  }
  return values;
}

const PRODUCT_LEVEL_COLUMNS = [
  ['name', 'name'],
  ['brand', 'brand'],
  ['description', 'description'],
  ['category_hint', 'categoryHint'],
] as const;

function firstConflict(
  product: ParsedProduct,
  row: Record<string, unknown>,
): { column: string; expected: string; found: string } | undefined {
  for (const [column, field] of PRODUCT_LEVEL_COLUMNS) {
    const expected = product[field] ?? '';
    const found = (row[column] as string | undefined) ?? '';
    if (expected !== found) return { column, expected, found };
  }
  return undefined;
}

/**
 * Folds a row's axes into the product's declared set. Every row of a product must use the
 * same axis names — a row that suddenly says "fabric" where its siblings say "colour"
 * would otherwise produce a variant matrix with a hole in it.
 */
function mergeAxes(
  product: ParsedProduct,
  optionValues: Record<string, string>,
): string | undefined {
  const names = Object.keys(optionValues);

  if (product.optionAxes.length === 0) {
    product.optionAxes.push(...names.map((name) => ({ name, values: [] as string[] })));
  } else {
    const declared = product.optionAxes.map((a) => a.name);
    const same = declared.length === names.length && declared.every((n, i) => n === names[i]);
    if (!same) {
      return (
        `option axes here are ${quote(names)} but this product declared ${quote(declared)} on line ${product.sourceRow}. ` +
        'Every row of a product must use the same axes, in the same order.'
      );
    }
  }

  for (const axis of product.optionAxes) {
    const value = optionValues[axis.name];
    if (value !== undefined && !axis.values.includes(value)) axis.values.push(value);
  }
  return undefined;
}

function sameOptions(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

function describeOptions(options: Record<string, string>): string {
  return Object.entries(options)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
}

function columnOf(issue: ZodIssue): string | undefined {
  const first = issue.path[0];
  return typeof first === 'string' ? first : undefined;
}

export function quote(values: readonly string[]): string {
  return values.map((v) => `"${v}"`).join(', ');
}
