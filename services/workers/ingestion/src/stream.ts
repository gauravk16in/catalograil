import { Readable } from 'node:stream';
import { checkHeaders, zipRow, type CsvFileRejection, type CsvTemplate } from '@catalograil/core';
import { parse } from 'csv-parse';

/**
 * Streaming CSV reader for T1.11.
 *
 * The task says not to load the file into memory, and this is the half that honours it:
 * bytes arrive from S3 in chunks, csv-parse emits one record at a time, and no more than a
 * row is held at once. The collapsed *products* still accumulate downstream — see the note
 * on `CatalogRowCollector.maxProducts` for why that is unavoidable and where the ceiling
 * is — but the raw file never exists in memory as a string.
 *
 * The header row is validated before any data row is yielded, so a header mismatch aborts
 * the read having imported nothing at all.
 */

export interface CsvStreamRow {
  readonly record: Record<string, string>;
  /** Spreadsheet line number, header being line 1. */
  readonly rowNumber: number;
}

export class CsvHeaderRejection extends Error {
  readonly rejection: CsvFileRejection;

  constructor(rejection: CsvFileRejection) {
    super(rejection.message);
    this.name = 'CsvHeaderRejection';
    this.rejection = rejection;
  }
}

/**
 * Yields data rows in file order.
 *
 * Throws `CsvHeaderRejection` before the first row if the header does not match the
 * template exactly — the caller turns that into a whole-file rejection.
 */
export async function* streamCsvRows(
  source: AsyncIterable<Uint8Array>,
  template: CsvTemplate,
): AsyncGenerator<CsvStreamRow> {
  const parser = parse({
    columns: false,
    skip_empty_lines: true,
    relax_column_count: true,
    // Excel writes a UTF-8 BOM; without this it corrupts the first header name.
    bom: true,
    trim: false,
  });

  // Piping rather than awaiting the whole body keeps backpressure intact: the parser only
  // pulls more bytes as records are consumed.
  Readable.from(source).pipe(parser);

  let headers: string[] | undefined;
  let lineNumber = 0;

  for await (const row of parser as AsyncIterable<string[]>) {
    lineNumber++;

    if (!headers) {
      headers = row.map((h) => h.trim());
      const mismatch = checkHeaders(headers, template);
      if (mismatch) {
        parser.destroy();
        throw new CsvHeaderRejection(mismatch);
      }
      continue;
    }

    yield { record: zipRow(headers, row), rowNumber: lineNumber };
  }

  if (!headers) {
    throw new CsvHeaderRejection({
      code: 'CSV_EMPTY',
      message: 'The file is empty. Download a template and fill it in.',
    });
  }
}
