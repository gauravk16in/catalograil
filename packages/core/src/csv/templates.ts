/**
 * T1.10 — the two CSV templates merchants upload against.
 *
 * These header arrays are the contract. A file whose headers do not match exactly is
 * rejected whole (see `validateCatalogCsv`), so this is the single place a column name
 * is ever spelled. The dashboard's template download (T1.24) is generated from the same
 * arrays, which is what keeps the file a merchant downloads and the file the validator
 * expects from ever drifting apart.
 */

export const CSV_TEMPLATES = ['simple', 'variant'] as const;
export type CsvTemplate = (typeof CSV_TEMPLATES)[number];

/** Up to three images per row, per the T1.10 template. At least one is required. */
export const MAX_IMAGE_COLUMNS = 3;

/** Up to three option axes on a variant product, e.g. size × colour × fabric. */
export const MAX_OPTION_AXES = 3;

export const SIMPLE_HEADERS = [
  'external_ref',
  'name',
  'brand',
  'description',
  'category_hint',
  'price',
  'mrp',
  'stock',
  'delivery_days',
  'weight_grams',
  'image_url_1',
  'image_url_2',
  'image_url_3',
] as const;

export const VARIANT_HEADERS = [
  'external_ref',
  'name',
  'brand',
  'description',
  'category_hint',
  'option_axis_1_name',
  'option_axis_1_value',
  'option_axis_2_name',
  'option_axis_2_value',
  'option_axis_3_name',
  'option_axis_3_value',
  'sku',
  'price',
  'mrp',
  'stock',
  'delivery_days',
  'image_url_1',
  'image_url_2',
  'image_url_3',
] as const;

export type SimpleHeader = (typeof SIMPLE_HEADERS)[number];
export type VariantHeader = (typeof VARIANT_HEADERS)[number];

export function headersFor(template: CsvTemplate): readonly string[] {
  return template === 'simple' ? SIMPLE_HEADERS : VARIANT_HEADERS;
}

/**
 * Sample rows shipped in the downloadable template. Real-looking values matter more than
 * they might seem: merchants copy the shape of the example, so a blank template invites a
 * file full of guesses about how to spell an option axis.
 */
const SIMPLE_SAMPLE_ROWS: readonly string[][] = [
  [
    'DASH-4K-001',
    'RoadEye 4K Dashcam',
    'RoadEye',
    'Front-facing 4K dashcam with 170 degree wide angle, night mode and loop recording.',
    'car accessories',
    '8499',
    '10999',
    '42',
    '3',
    '210',
    'https://example.com/dashcam-front.jpg',
    'https://example.com/dashcam-box.jpg',
    '',
  ],
];

const VARIANT_SAMPLE_ROWS: readonly string[][] = [
  [
    'SHIRT-OXF-001',
    'Oxford Cotton Shirt',
    'Meridian',
    'Long sleeve oxford cotton shirt with a button-down collar. Regular fit.',
    'shirts',
    'size',
    '40',
    'colour',
    'white',
    '',
    '',
    'SHIRT-OXF-001-40-WHITE',
    '1899',
    '2799',
    '12',
    '3',
    'https://example.com/shirt-white.jpg',
    '',
    '',
  ],
  [
    'SHIRT-OXF-001',
    'Oxford Cotton Shirt',
    'Meridian',
    'Long sleeve oxford cotton shirt with a button-down collar. Regular fit.',
    'shirts',
    'size',
    '42',
    'colour',
    'white',
    '',
    '',
    'SHIRT-OXF-001-42-WHITE',
    '1899',
    '2799',
    '8',
    '3',
    'https://example.com/shirt-white.jpg',
    '',
    '',
  ],
  [
    'SHIRT-OXF-001',
    'Oxford Cotton Shirt',
    'Meridian',
    'Long sleeve oxford cotton shirt with a button-down collar. Regular fit.',
    'shirts',
    'size',
    '42',
    'colour',
    'lilac',
    '',
    '',
    'SHIRT-OXF-001-42-LILAC',
    '1899',
    '2799',
    '0',
    '3',
    'https://example.com/shirt-lilac.jpg',
    '',
    '',
  ],
];

/**
 * Renders a template file, headers plus sample rows. Served by the dashboard's
 * template download.
 *
 * Note the sample variant rows share one `external_ref` and differ only by option value —
 * that collapse into a single three-variant product is the part merchants most often get
 * wrong, so the example demonstrates it rather than describing it.
 */
export function buildTemplateCsv(template: CsvTemplate): string {
  const headers = headersFor(template);
  const rows = template === 'simple' ? SIMPLE_SAMPLE_ROWS : VARIANT_SAMPLE_ROWS;
  return (
    [headers.join(','), ...rows.map((row) => row.map(escapeCsvValue).join(','))].join('\n') + '\n'
  );
}

export function templateFilename(template: CsvTemplate): string {
  return `${template}-products.csv`;
}

/** Quotes a value only when it needs it, so a template stays readable in a text editor. */
export function escapeCsvValue(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
