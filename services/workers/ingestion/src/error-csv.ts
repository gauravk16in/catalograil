import { escapeCsvValue, type CsvRowError } from '@catalograil/core';

/**
 * The downloadable error report (T1.11, surfaced by T1.24).
 *
 * Sorted by line number so it reads alongside the merchant's own file, and columns are
 * named for a spreadsheet rather than a log: a merchant opens this next to their CSV and
 * fixes rows top to bottom.
 */
const ERROR_CSV_HEADERS = ['row', 'column', 'problem'] as const;

export function buildErrorCsv(errors: readonly CsvRowError[]): string {
  const sorted = [...errors].sort(
    (a, b) => a.row - b.row || (a.column ?? '').localeCompare(b.column ?? ''),
  );
  return (
    [
      ERROR_CSV_HEADERS.join(','),
      ...sorted.map((e) =>
        [String(e.row), e.column ?? '', e.message].map(escapeCsvValue).join(','),
      ),
    ].join('\n') + '\n'
  );
}

export function errorCsvKey(
  merchantId: string,
  jobId: string,
  prefix = 'ingestion-errors',
): string {
  return `${prefix}/${merchantId}/${jobId}.csv`;
}
