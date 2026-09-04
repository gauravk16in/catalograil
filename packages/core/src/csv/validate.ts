import { parse } from 'csv-parse/sync';
import { MAX_STORED_INGESTION_ERRORS } from '../constants/index.js';
import { AppError } from '../errors/index.js';
import { CatalogRowCollector, quote, type CsvRowError, type ParsedProduct } from './collector.js';
import { headersFor, type CsvTemplate } from './templates.js';

/**
 * T1.10 — validates an uploaded catalogue file and collapses it into products.
 *
 * The governing decision is in the task: **reject the entire file on a header mismatch**.
 * A half-imported 500-row file is worse than a clean failure, because the merchant cannot
 * tell which half landed. So header trouble is fatal and nothing is returned; everything
 * else is a row error, and the good rows still import (T1.11).
 *
 * This entry point holds the whole file in memory, which is right for a dashboard preview
 * and for tests. The ingestion worker streams instead — both drive the same
 * `CatalogRowCollector`, so the rules cannot differ between the two paths.
 */

export type { CsvRowError, ParsedProduct, ParsedVariant } from './collector.js';
export { CatalogRowCollector } from './collector.js';

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
  readonly maxProducts?: number;
}

export function validateCatalogCsv(
  content: string,
  template: CsvTemplate,
  options: ValidateOptions = {},
): CsvValidationResult {
  let records: Record<string, string>[];

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

    const headers = headerRow.map((h) => h.trim());
    const mismatch = checkHeaders(headers, template);
    if (mismatch) return rejected(template, mismatch);

    records = rows.slice(1).map((row) => zipRow(headers, row));
  } catch (err) {
    return rejected(template, {
      code: 'CSV_UNPARSEABLE',
      message: `The file could not be read as CSV: ${(err as Error).message}`,
    });
  }

  const collector = new CatalogRowCollector(template, {
    maxErrors: options.maxErrors ?? MAX_STORED_INGESTION_ERRORS,
    ...(options.maxProducts !== undefined ? { maxProducts: options.maxProducts } : {}),
  });
  records.forEach((record, index) => collector.addRow(record, index + 2)); // header is line 1

  return {
    template,
    products: collector.products,
    errors: [...collector.errors],
    errorCount: collector.errorCount,
    rowsTotal: collector.rowsTotal,
    rowsValid: collector.rowsValid,
  };
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
export function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

/** Pairs a raw row with the header names. Short rows fill with empty strings. */
export function zipRow(headers: readonly string[], row: readonly string[]): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((header, i) => {
    record[header] = row[i] ?? '';
  });
  return record;
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
