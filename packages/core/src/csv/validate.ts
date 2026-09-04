import { parse } from 'csv-parse/sync';
import type { ZodIssue } from 'zod';
import { MAX_STORED_INGESTION_ERRORS } from '../constants/index.js';
import type { Archetype } from '../constants/index.js';
import { AppError } from '../errors/index.js';
import { simpleRowSchema, variantRowSchema } from './schemas.js';
import { MAX_IMAGE_COLUMNS, MAX_OPTION_AXES, headersFor, type CsvTemplate } from './templates.js';

/**
 * T1.10 — validates an uploaded catalogue file and collapses it into products.
 *
 * The governing decision is in the task: **reject the entire file on a header mismatch**.
 * A half-imported 500-row file is worse than a clean failure, because the merchant cannot
 * tell which half landed. So header trouble is fatal and nothing is returned; everything
 * else is a row error, and the good rows still import (T1.11).
 *
 * Row numbers throughout are spreadsheet line numbers — the header is line 1 and the first
 * data row is line 2 — so a merchant can open the file and go straight to the line named.
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

export interface CsvFileRejection {
  readonly code: 'CSV_HEADER_MISMATCH' | 'CSV_EMPTY' | 'CSV_UNPARSEABLE';
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export interface CsvValidationResult {
  readonly template: CsvTemplate;
  /** Set only when the whole file was rejected; `products` is empty when it is. */
  readonly rejection?: CsvFileRejection;
  readonly products: ParsedProduct[];
  readonly errors: CsvRowError[];
  /** Errors are capped for storage (T1.11); this is the true count. */
  readonly errorCount: number;
  readonly rowsTotal: number;
  readonly rowsValid: number;
}

export interface ValidateOptions {
  /** Cap on *stored* errors. Everything is still counted. */
  readonly maxErrors?: number;
}

/**
 * Validates a whole file held in memory. T1.11 streams large uploads instead, but shares
 * these row schemas and this collapse logic — the difference is only where rows come from.
 */
export function validateCatalogCsv(
  content: string,
  template: CsvTemplate,
  options: ValidateOptions = {},
): CsvValidationResult {
  const maxErrors = options.maxErrors ?? MAX_STORED_INGESTION_ERRORS;

  let records: Record<string, string>[];
  let headers: string[];

  try {
    // `columns: true` would silently accept any header set, so headers are read as data
    // and compared explicitly — a mismatch has to be reported by name, not tolerated.
    const rows = parse(stripBom(content), {
      columns: false,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: false,
    }) as string[][];

    const headerRow = rows[0];
    if (!headerRow) {
      return rejected(template, {
        code: 'CSV_EMPTY',
        message: 'The file is empty. Download a template and fill it in.',
      });
    }

    headers = headerRow.map((h) => h.trim());
    const mismatch = checkHeaders(headers, template);
    if (mismatch) return rejected(template, mismatch);

    records = rows.slice(1).map((row) => zip(headers, row));
  } catch (err) {
    return rejected(template, {
      code: 'CSV_UNPARSEABLE',
      message: `The file could not be read as CSV: ${(err as Error).message}`,
    });
  }

  return validateRecords(records, template, maxErrors);
}

/**
 * Header comparison. Exact match, in order — the templates are generated from the same
 * arrays, so anything else means the merchant edited the header row.
 *
 * The task requires naming the offending header, so the message distinguishes a
 * misspelling from a missing or an extra column rather than saying "headers do not match".
 */
export function checkHeaders(
  headers: readonly string[],
  template: CsvTemplate,
): CsvFileRejection | undefined {
  const expected = headersFor(template);
  if (headers.length === expected.length && expected.every((h, i) => headers[i] === h)) {
    return undefined;
  }

  const expectedSet = new Set(expected);
  const actualSet = new Set(headers);
  const missing = expected.filter((h) => !actualSet.has(h));
  const unexpected = headers.filter((h) => !expectedSet.has(h));

  // A single missing / single extra pair is nearly always one typo. Say so.
  const parts: string[] = [];
  if (missing.length === 1 && unexpected.length === 1) {
    parts.push(`found "${unexpected[0]}" where "${missing[0]}" was expected`);
  } else {
    if (unexpected.length > 0)
      parts.push(`unexpected ${plural('column', unexpected)}: ${quote(unexpected)}`);
    if (missing.length > 0) parts.push(`missing ${plural('column', missing)}: ${quote(missing)}`);
    if (parts.length === 0) parts.push('the columns are in the wrong order');
  }

  return {
    code: 'CSV_HEADER_MISMATCH',
    message: `Header row does not match the ${template} template — ${parts.join('; ')}. The file was not imported.`,
    details: { missing, unexpected, expected: [...expected], found: [...headers] },
  };
}

function validateRecords(
  records: Record<string, string>[],
  template: CsvTemplate,
  maxErrors: number,
): CsvValidationResult {
  const schema = template === 'simple' ? simpleRowSchema : variantRowSchema;
  const errors: CsvRowError[] = [];
  let errorCount = 0;

  const addError = (row: number, message: string, column?: string): void => {
    errorCount++;
    if (errors.length < maxErrors) errors.push({ row, ...(column ? { column } : {}), message });
  };

  const byRef = new Map<string, ParsedProduct>();
  const seenSkus = new Map<string, number>();
  let rowsValid = 0;

  records.forEach((record, index) => {
    const rowNumber = index + 2; // header is line 1
    const parsed = schema.safeParse(record);

    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        addError(rowNumber, issue.message, columnOf(issue));
      }
      return;
    }

    const row = parsed.data as Record<string, unknown>;
    const externalRef = row.external_ref as string;
    const images = collectImages(row);

    if (template === 'variant') {
      const sku = row.sku as string;
      const firstSeen = seenSkus.get(sku);
      if (firstSeen !== undefined) {
        addError(rowNumber, `duplicate SKU "${sku}", already used on line ${firstSeen}`, 'sku');
        return;
      }
      seenSkus.set(sku, rowNumber);
    }

    const optionValues = template === 'variant' ? collectOptionValues(row) : {};

    let product = byRef.get(externalRef);
    if (!product) {
      product = {
        externalRef,
        archetype: template === 'simple' ? 'SIMPLE' : 'VARIANT',
        name: row.name as string,
        ...(row.brand ? { brand: row.brand as string } : {}),
        ...(row.description ? { description: row.description as string } : {}),
        ...(row.category_hint ? { categoryHint: row.category_hint as string } : {}),
        images: [...images],
        optionAxes: [],
        variants: [],
        sourceRow: rowNumber,
      };
      byRef.set(externalRef, product);
    } else if (template === 'simple') {
      addError(
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
        addError(
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

    if (template === 'variant') {
      const axisConflict = mergeAxes(product, optionValues);
      if (axisConflict) {
        addError(rowNumber, axisConflict, 'option_axis_1_name');
        return;
      }

      const duplicate = product.variants.find((v) => sameOptions(v.optionValues, optionValues));
      if (duplicate) {
        addError(
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
    rowsValid++;
  });

  return {
    template,
    products: [...byRef.values()],
    errors,
    errorCount,
    rowsTotal: records.length,
    rowsValid,
  };
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

// ─── Small helpers ────────────────────────────────────────────────────────────────

function rejected(template: CsvTemplate, rejection: CsvFileRejection): CsvValidationResult {
  return {
    template,
    rejection,
    products: [],
    errors: [],
    errorCount: 0,
    rowsTotal: 0,
    rowsValid: 0,
  };
}

/** Excel writes a UTF-8 BOM, which would otherwise corrupt the first header name. */
function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

function zip(headers: string[], row: string[]): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((header, i) => {
    record[header] = row[i] ?? '';
  });
  return record;
}

function columnOf(issue: ZodIssue): string | undefined {
  const first = issue.path[0];
  return typeof first === 'string' ? first : undefined;
}

function quote(values: readonly string[]): string {
  return values.map((v) => `"${v}"`).join(', ');
}

function plural(word: string, values: readonly unknown[]): string {
  return values.length === 1 ? word : `${word}s`;
}

/**
 * Throws when a file was rejected outright. Handlers that want the 400 rather than a
 * result object call this.
 */
export function assertNotRejected(result: CsvValidationResult): void {
  if (result.rejection) {
    throw new AppError(
      result.rejection.code === 'CSV_HEADER_MISMATCH' ? 'CSV_HEADER_MISMATCH' : 'CSV_ROW_INVALID',
      result.rejection.message,
      { details: result.rejection.details },
    );
  }
}
