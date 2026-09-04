import { type IngestionOutcome } from './ingest.js';

/**
 * Merchant-facing summaries. Plain text and specific — a merchant should be able to act on
 * the message without opening the dashboard, so counts are stated rather than implied and
 * the first few failing lines are quoted inline.
 */

const INLINE_ERROR_SAMPLE = 5;

export function renderCompletionEmail(outcome: IngestionOutcome): {
  subject: string;
  text: string;
} {
  const clean = outcome.rowsFailed === 0;
  const subject = clean
    ? `Your catalogue upload is complete — ${outcome.rowsImported} rows imported`
    : `Your catalogue upload finished with ${outcome.rowsFailed} problem ${outcome.rowsFailed === 1 ? 'row' : 'rows'}`;

  const lines = [
    clean
      ? `All ${outcome.rowsImported} rows imported successfully.`
      : `${outcome.rowsImported} of ${outcome.rowsTotal} rows imported. ${outcome.rowsFailed} could not be.`,
    '',
    `Products created:  ${outcome.productsCreated}`,
    `Products updated:  ${outcome.productsUpdated}`,
    `Variants written:  ${outcome.variantsUpserted}`,
  ];

  if (outcome.errors.length > 0) {
    lines.push('', 'The first few problems:');
    for (const error of outcome.errors.slice(0, INLINE_ERROR_SAMPLE)) {
      lines.push(
        `  line ${error.row}${error.column ? ` (${error.column})` : ''}: ${error.message}`,
      );
    }
    if (outcome.errorCount > INLINE_ERROR_SAMPLE) {
      lines.push(`  …and ${outcome.errorCount - INLINE_ERROR_SAMPLE} more.`);
    }
    lines.push('', 'The attached CSV lists every problem row with its line number.');
  }

  lines.push(
    '',
    'Imported products are being categorised and indexed now, and will appear in search shortly.',
  );

  return { subject, text: lines.join('\n') };
}

export function renderRejectionEmail(reason: string): { subject: string; text: string } {
  return {
    subject: 'Your catalogue upload could not be imported',
    text: [
      'The file was not imported. Nothing in your catalogue has changed.',
      '',
      reason,
      '',
      'Download a fresh template from the dashboard, copy your data into it without editing the header row, and upload again.',
    ].join('\n'),
  };
}
