import { describe, expect, it } from 'vitest';
import {
  SIMPLE_HEADERS,
  VARIANT_HEADERS,
  buildTemplateCsv,
  checkHeaders,
  validateCatalogCsv,
} from './index.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────────

function csv(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  return [headers.join(','), ...rows.map((r) => r.join(','))].join('\n') + '\n';
}

function simpleRow(overrides: Partial<Record<string, string>> = {}): string[] {
  const base: Record<string, string> = {
    external_ref: 'DASH-001',
    name: 'RoadEye 4K Dashcam',
    brand: 'RoadEye',
    description: 'Front-facing 4K dashcam.',
    category_hint: 'car accessories',
    price: '8499',
    mrp: '10999',
    stock: '42',
    delivery_days: '3',
    weight_grams: '210',
    image_url_1: 'https://example.com/a.jpg',
    image_url_2: '',
    image_url_3: '',
  };
  return SIMPLE_HEADERS.map((h) => overrides[h] ?? base[h] ?? '');
}

function variantRow(overrides: Partial<Record<string, string>> = {}): string[] {
  const base: Record<string, string> = {
    external_ref: 'SHIRT-001',
    name: 'Oxford Cotton Shirt',
    brand: 'Meridian',
    description: 'Long sleeve oxford shirt.',
    category_hint: 'shirts',
    option_axis_1_name: 'size',
    option_axis_1_value: '40',
    option_axis_2_name: 'colour',
    option_axis_2_value: 'white',
    option_axis_3_name: '',
    option_axis_3_value: '',
    sku: 'SHIRT-001-40-WHITE',
    price: '1899',
    mrp: '2799',
    stock: '12',
    delivery_days: '3',
    image_url_1: 'https://example.com/shirt.jpg',
    image_url_2: '',
    image_url_3: '',
  };
  return VARIANT_HEADERS.map((h) => overrides[h] ?? base[h] ?? '');
}

// ─── Acceptance criterion 1 ───────────────────────────────────────────────────────

describe('a 200-row variant file collapses correctly', () => {
  /**
   * 10 products × (4 sizes × 5 colours) = 200 rows collapsing to 10 products of 20
   * variants each. This is the T1.10 acceptance case.
   */
  const sizes = ['38', '40', '42', '44'];
  const colours = ['white', 'sky', 'lilac', 'black', 'sand'];
  const rows: string[][] = [];

  for (let p = 1; p <= 10; p++) {
    const ref = `SHIRT-${String(p).padStart(3, '0')}`;
    for (const size of sizes) {
      for (const colour of colours) {
        rows.push(
          variantRow({
            external_ref: ref,
            name: `Oxford Shirt ${p}`,
            description: `Shirt number ${p}.`,
            option_axis_1_value: size,
            option_axis_2_value: colour,
            sku: `${ref}-${size}-${colour.toUpperCase()}`,
          }),
        );
      }
    }
  }

  const result = validateCatalogCsv(csv(VARIANT_HEADERS, rows), 'variant');

  it('imports every row', () => {
    expect(result.rejection).toBeUndefined();
    expect(result.rowsTotal).toBe(200);
    expect(result.rowsValid).toBe(200);
    expect(result.errors).toEqual([]);
  });

  it('collapses to the right product and variant counts', () => {
    expect(result.products).toHaveLength(10);
    for (const product of result.products) {
      expect(product.variants).toHaveLength(20);
    }
    expect(result.products.reduce((n, p) => n + p.variants.length, 0)).toBe(200);
  });

  it('derives the option axes with their values in first-seen order', () => {
    const first = result.products[0]!;
    expect(first.optionAxes).toEqual([
      { name: 'size', values: sizes },
      { name: 'colour', values: colours },
    ]);
  });

  it('keeps prices as bigint paise', () => {
    const variant = result.products[0]!.variants[0]!;
    expect(variant.pricePaise).toBe(189900n);
    expect(variant.mrpPaise).toBe(279900n);
  });
});

// ─── Acceptance criterion 2 ───────────────────────────────────────────────────────

describe('header mismatch rejects the whole file', () => {
  it('names the offending header on a typo', () => {
    const typoed = VARIANT_HEADERS.map((h) => (h === 'delivery_days' ? 'delivery_day' : h));
    const result = validateCatalogCsv(csv(typoed, [variantRow()]), 'variant');

    expect(result.rejection?.code).toBe('CSV_HEADER_MISMATCH');
    expect(result.rejection?.message).toContain('"delivery_day"');
    expect(result.rejection?.message).toContain('"delivery_days"');
    // A half-imported file is worse than a clean failure.
    expect(result.products).toEqual([]);
    expect(result.rowsValid).toBe(0);
  });

  it('rejects even when every row would have been valid', () => {
    const extra = [...SIMPLE_HEADERS, 'notes'];
    const result = validateCatalogCsv(csv(extra, [[...simpleRow(), 'some note']]), 'simple');
    expect(result.rejection?.code).toBe('CSV_HEADER_MISMATCH');
    expect(result.rejection?.message).toContain('"notes"');
    expect(result.products).toEqual([]);
  });

  it('reports a missing column', () => {
    const missing = SIMPLE_HEADERS.filter((h) => h !== 'mrp');
    const result = validateCatalogCsv(csv(missing, []), 'simple');
    expect(result.rejection?.message).toContain('missing column: "mrp"');
  });

  it('rejects columns in the wrong order', () => {
    const swapped = [...SIMPLE_HEADERS];
    [swapped[1], swapped[2]] = [swapped[2]!, swapped[1]!];
    const result = validateCatalogCsv(csv(swapped, []), 'simple');
    expect(result.rejection?.code).toBe('CSV_HEADER_MISMATCH');
    expect(result.rejection?.message).toContain('wrong order');
  });

  it('accepts the headers of its own downloadable template', () => {
    for (const template of ['simple', 'variant'] as const) {
      const result = validateCatalogCsv(buildTemplateCsv(template), template);
      expect(result.rejection).toBeUndefined();
      expect(result.errors).toEqual([]);
    }
  });

  it('tolerates a UTF-8 BOM, which is what Excel writes', () => {
    const result = validateCatalogCsv('﻿' + csv(SIMPLE_HEADERS, [simpleRow()]), 'simple');
    expect(result.rejection).toBeUndefined();
    expect(result.products).toHaveLength(1);
  });

  it('checkHeaders passes an exact match', () => {
    expect(checkHeaders([...SIMPLE_HEADERS], 'simple')).toBeUndefined();
  });
});

// ─── Row-level validation ─────────────────────────────────────────────────────────

describe('row errors', () => {
  it('reports the offending line, so 10 bad rows in 500 are findable', () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      simpleRow({ external_ref: `REF-${i}`, price: i === 7 ? '0' : '999' }),
    );
    const result = validateCatalogCsv(csv(SIMPLE_HEADERS, rows), 'simple');

    expect(result.rowsValid).toBe(19);
    expect(result.errors).toHaveLength(1);
    // Header is line 1, so data row index 7 is line 9.
    expect(result.errors[0]).toMatchObject({ row: 9, column: 'price' });
    expect(result.errors[0]?.message).toContain('greater than 0');
    // The other 19 still import.
    expect(result.products).toHaveLength(19);
  });

  it('requires at least one image', () => {
    const result = validateCatalogCsv(
      csv(SIMPLE_HEADERS, [simpleRow({ image_url_1: '' })]),
      'simple',
    );
    expect(result.errors[0]).toMatchObject({ column: 'image_url_1' });
    expect(result.errors[0]?.message).toContain('at least one image');
  });

  it('rejects a non-http image URL rather than failing later in the embedding worker', () => {
    const result = validateCatalogCsv(
      csv(SIMPLE_HEADERS, [simpleRow({ image_url_1: 'file:///Users/kr/photo.jpg' })]),
      'simple',
    );
    expect(result.errors[0]?.message).toContain('http or https');
  });

  it('rejects a malformed price without ever making it a float', () => {
    // Three decimal places is not a rupee amount; rounding it silently would be worse.
    const result = validateCatalogCsv(
      csv(SIMPLE_HEADERS, [simpleRow({ price: '12.999' })]),
      'simple',
    );
    expect(result.errors[0]).toMatchObject({ column: 'price' });
    expect(result.errors[0]?.message).toContain('not a valid amount');
  });

  it('accepts a quoted price written with Indian digit grouping', () => {
    const result = validateCatalogCsv(
      csv(SIMPLE_HEADERS, [simpleRow({ price: '"1,24,999.99"', mrp: '"1,49,999"' })]),
      'simple',
    );
    expect(result.errors).toEqual([]);
    expect(result.products[0]?.variants[0]?.pricePaise).toBe(12499999n);
  });

  it('rejects an mrp below the price', () => {
    const result = validateCatalogCsv(
      csv(SIMPLE_HEADERS, [simpleRow({ price: '999', mrp: '499' })]),
      'simple',
    );
    expect(result.errors[0]).toMatchObject({ column: 'mrp' });
  });

  it('requires whole numbers for stock', () => {
    const result = validateCatalogCsv(csv(SIMPLE_HEADERS, [simpleRow({ stock: '4.5' })]), 'simple');
    expect(result.errors[0]?.message).toContain('whole number');
  });

  it('caps stored errors but keeps counting them', () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      simpleRow({ external_ref: `R-${i}`, price: '0' }),
    );
    const result = validateCatalogCsv(csv(SIMPLE_HEADERS, rows), 'simple', { maxErrors: 5 });
    expect(result.errors).toHaveLength(5);
    expect(result.errorCount).toBe(30);
  });
});

// ─── Variant-specific collapse rules ──────────────────────────────────────────────

describe('variant collapse rules', () => {
  it('rejects a duplicate SKU and names the line it first appeared on', () => {
    const result = validateCatalogCsv(
      csv(VARIANT_HEADERS, [
        variantRow({ option_axis_1_value: '40', sku: 'DUP' }),
        variantRow({ option_axis_1_value: '42', sku: 'DUP' }),
      ]),
      'variant',
    );
    expect(result.errors[0]).toMatchObject({ row: 3, column: 'sku' });
    expect(result.errors[0]?.message).toContain('already used on line 2');
    expect(result.products[0]?.variants).toHaveLength(1);
  });

  it('rejects a repeated option combination', () => {
    const result = validateCatalogCsv(
      csv(VARIANT_HEADERS, [
        variantRow({ sku: 'A' }),
        variantRow({ sku: 'B' }), // same size and colour as A
      ]),
      'variant',
    );
    expect(result.errors[0]?.message).toContain('already defined on line 2');
    expect(result.products[0]?.variants).toHaveLength(1);
  });

  it('rejects a row whose axes disagree with its siblings', () => {
    const result = validateCatalogCsv(
      csv(VARIANT_HEADERS, [
        variantRow({ sku: 'A' }),
        variantRow({ sku: 'B', option_axis_2_name: 'fabric', option_axis_2_value: 'linen' }),
      ]),
      'variant',
    );
    expect(result.errors[0]?.message).toContain('same axes');
    expect(result.products[0]?.optionAxes.map((a) => a.name)).toEqual(['size', 'colour']);
  });

  it('rejects a half-declared axis', () => {
    const result = validateCatalogCsv(
      csv(VARIANT_HEADERS, [variantRow({ option_axis_2_value: '' })]),
      'variant',
    );
    expect(result.errors[0]?.message).toContain('option_axis_2_value is empty');
  });

  it('requires at least one axis on a variant row', () => {
    const result = validateCatalogCsv(
      csv(VARIANT_HEADERS, [
        variantRow({
          option_axis_1_name: '',
          option_axis_1_value: '',
          option_axis_2_name: '',
          option_axis_2_value: '',
        }),
      ]),
      'variant',
    );
    expect(result.errors[0]?.message).toContain('at least one option axis');
  });

  it('reports product-level columns that disagree between rows of one product', () => {
    const result = validateCatalogCsv(
      csv(VARIANT_HEADERS, [
        variantRow({ sku: 'A' }),
        variantRow({ sku: 'B', option_axis_1_value: '42', name: 'Oxford Shirt (Slim)' }),
      ]),
      'variant',
    );
    expect(result.errors[0]).toMatchObject({ row: 3, column: 'name' });
    expect(result.errors[0]?.message).toContain('line 2');
    // The first occurrence wins; the later row does not silently rewrite it.
    expect(result.products[0]?.name).toBe('Oxford Cotton Shirt');
  });

  it('unions images across the rows of one product', () => {
    const result = validateCatalogCsv(
      csv(VARIANT_HEADERS, [
        variantRow({ sku: 'A', image_url_1: 'https://example.com/white.jpg' }),
        variantRow({
          sku: 'B',
          option_axis_2_value: 'lilac',
          image_url_1: 'https://example.com/lilac.jpg',
        }),
      ]),
      'variant',
    );
    expect(result.products[0]?.images).toEqual([
      'https://example.com/white.jpg',
      'https://example.com/lilac.jpg',
    ]);
    // Each variant still keeps only its own.
    expect(result.products[0]?.variants[1]?.images).toEqual(['https://example.com/lilac.jpg']);
  });

  it('points a merchant at the variant template when a simple ref repeats', () => {
    const result = validateCatalogCsv(csv(SIMPLE_HEADERS, [simpleRow(), simpleRow()]), 'simple');
    expect(result.errors[0]?.message).toContain('variant template');
    expect(result.products).toHaveLength(1);
  });
});

// ─── Parsing edge cases ───────────────────────────────────────────────────────────

describe('parsing', () => {
  it('handles quoted fields containing commas and newlines', () => {
    const content =
      VARIANT_HEADERS.join(',') +
      '\n' +
      [
        'SHIRT-001',
        '"Oxford Shirt, Regular Fit"',
        'Meridian',
        '"Long sleeve.\nMachine washable."',
        'shirts',
        'size',
        '40',
        '',
        '',
        '',
        '',
        'SKU-1',
        '1899',
        '2799',
        '5',
        '3',
        'https://example.com/a.jpg',
        '',
        '',
      ].join(',') +
      '\n';

    const result = validateCatalogCsv(content, 'variant');
    expect(result.rejection).toBeUndefined();
    expect(result.products[0]?.name).toBe('Oxford Shirt, Regular Fit');
    expect(result.products[0]?.description).toContain('Machine washable.');
  });

  it('rejects an empty file with a usable message', () => {
    const result = validateCatalogCsv('', 'simple');
    expect(result.rejection?.code).toBe('CSV_EMPTY');
    expect(result.rejection?.message).toContain('template');
  });

  it('treats a header-only file as valid but empty', () => {
    const result = validateCatalogCsv(csv(SIMPLE_HEADERS, []), 'simple');
    expect(result.rejection).toBeUndefined();
    expect(result.products).toEqual([]);
    expect(result.rowsTotal).toBe(0);
  });
});
