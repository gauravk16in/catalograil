/**
 * Writes the CSV templates and their guides into the merchant dashboard's `public/`.
 *
 * S4.1. They used to be served from an API route, which put a plain file download behind
 * IAM authorization — so the browser got a 403 and the merchant got a broken button. A
 * static asset has no auth, no signed URL, no S3 object to go missing, no Lambda to cold
 * start, and nothing to break.
 *
 * Generated at build time rather than committed, so the file a merchant downloads can never
 * disagree with the headers the validator enforces.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildTemplateCsv,
  buildTemplateGuide,
  CSV_TEMPLATES,
  templateFilename,
} from '../src/csv/templates.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

/**
 * A UTF-8 BOM, for Excel.
 *
 * Without it Excel on Windows reads a UTF-8 CSV as the local ANSI codepage and mangles any
 * non-ASCII text — which for an Indian catalogue means names in Devanagari or Tamil arrive
 * as mojibake and the merchant concludes our template is broken. Sheets, Numbers and every
 * parser here ignore it.
 */
const BOM = '﻿';

const dir = join(repoRoot, 'apps/merchant/public/templates');
mkdirSync(dir, { recursive: true });

for (const template of CSV_TEMPLATES) {
  writeFileSync(join(dir, templateFilename(template)), BOM + buildTemplateCsv(template), 'utf8');
  writeFileSync(join(dir, `${template}-products-guide.md`), buildTemplateGuide(template), 'utf8');
}

console.log(`Wrote ${CSV_TEMPLATES.length * 2} files to ${dir}`);
