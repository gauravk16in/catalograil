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

/**
 * What each column means, which values are accepted, and whether it is required.
 *
 * Shipped alongside the template rather than only living in a doc site, because a merchant
 * opens the CSV in Excel and never sees the doc site. The template download writes this out
 * as a companion file.
 */
export const COLUMN_DOCS: Readonly<Record<string, { required: boolean; note: string }>> = {
  external_ref: {
    required: true,
    // The join key for the whole import, and the one merchants most often get wrong.
    note: 'Your own product code. Re-importing the same value updates that product instead of creating a second one. For a variant product, every row of the same product shares this.',
  },
  name: { required: true, note: 'What a buyer would call it. Not a SKU.' },
  brand: { required: false, note: 'Leave blank if unbranded.' },
  description: {
    required: false,
    note: 'Plain sentences. This is the main thing search matches against, so describe what it is for, not just what it is.',
  },
  category_hint: {
    required: false,
    note: 'A rough category if you have one, e.g. "running shoes". We refine it automatically.',
  },
  price: { required: true, note: 'Rupees, e.g. 1899 or 1899.50. No symbols, no commas.' },
  mrp: { required: false, note: 'Rupees. Must be at least the price if given.' },
  stock: { required: true, note: 'Whole number. 0 hides it from search until restocked.' },
  delivery_days: {
    required: false,
    note: 'Typical days to deliver. Buyers filter on this, and an item that cannot arrive in time is excluded rather than ranked lower — so an honest number wins more orders than an optimistic one.',
  },
  weight_grams: { required: false, note: 'Whole number, grams.' },
  image_url_1: { required: true, note: 'Publicly reachable https URL. We fetch it once.' },
  image_url_2: { required: false, note: 'Optional.' },
  image_url_3: { required: false, note: 'Optional.' },
  sku: { required: true, note: 'Unique within the product. This is what gets ordered.' },
  option_axis_1_name: {
    required: true,
    note: 'What varies, e.g. "size". Up to three axes; use axes 2 and 3 only if you need them.',
  },
  option_axis_1_value: { required: true, note: 'This row’s value on that axis, e.g. "42".' },
  option_axis_2_name: { required: false, note: 'Second axis, e.g. "colour".' },
  option_axis_2_value: { required: false, note: 'Required if axis 2 is named.' },
  option_axis_3_name: { required: false, note: 'Third axis, e.g. "fabric".' },
  option_axis_3_value: { required: false, note: 'Required if axis 3 is named.' },
};

/**
 * The companion guide written beside each template.
 *
 * Markdown rather than a sheet inside the CSV: a second sheet is impossible in CSV, and a
 * commented header row breaks every parser including ours.
 */
export function buildTemplateGuide(template: CsvTemplate): string {
  const headers = headersFor(template);
  const lines = [
    `# ${template === 'simple' ? 'Simple' : 'Variant'} products — CSV guide`,
    '',
    template === 'simple'
      ? 'One row per product. Use this when a product has a single price and stock count.'
      : 'One row per **variant**. Rows sharing an `external_ref` collapse into one product with several options — that is the part most people get wrong, so the sample file shows three rows becoming one three-option product.',
    '',
    '## Columns',
    '',
    '| Column | Required | Notes |',
    '| --- | --- | --- |',
  ];

  for (const header of headers) {
    const doc = COLUMN_DOCS[header];
    lines.push(
      `| \`${header}\` | ${doc?.required ? 'Yes' : 'No'} | ${doc?.note ?? ''} |`,
    );
  }

  lines.push(
    '',
    '## Rules worth knowing before you upload',
    '',
    '- Headers must match exactly, in any order. A mismatch rejects the whole file rather than importing half of it.',
    '- Money is in rupees, written plainly: `1899` or `1899.50`. No `₹`, no thousands separators.',
    '- Re-importing a row with an `external_ref` you have used before **updates** that product. It never creates a duplicate.',
    '- Changing only price or stock does not re-run indexing, so those updates appear in search within seconds.',
    '- Nothing appears in search until it has been enriched and indexed. The Products page shows where each one is.',
    '',
  );

  return lines.join('\n');
}
