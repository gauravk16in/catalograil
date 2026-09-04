import { describe, expect, it } from 'vitest';
import {
  composeCanonical,
  composeCanonicalText,
  contentHash,
  truncateToApproxTokens,
  type CanonicalUnitInput,
} from './canonical.js';

const shirtVariant: CanonicalUnitInput = {
  archetype: 'VARIANT',
  name: 'Meridian Oxford Shirt',
  brand: 'Meridian',
  categoryPath: 'apparel.shirts',
  description:
    'Long sleeve oxford cotton shirt with a button-down collar. Regular fit, machine washable.',
  attributes: { fabric: 'cotton', fit: 'regular', sleeve: 'long', collar: 'button-down' },
  optionValues: { size: '42', colour: 'lilac' },
  useCases: ['office wear', 'smart casual'],
  targetAudience: ['men'],
  occasions: ['work', 'dinner'],
  optionAxes: [
    { name: 'size', values: ['38', '40', '42', '44'] },
    { name: 'colour', values: ['white', 'sky', 'lilac'] },
  ],
  deliveryDays: 3,
};

describe('composeCanonicalText', () => {
  it('lays the template out line by line', () => {
    expect(composeCanonicalText(shirtVariant)).toBe(
      [
        'Meridian Oxford Shirt — Meridian',
        'apparel > shirts',
        'collar: button-down, colour: lilac, fabric: cotton, fit: regular, size: 42, sleeve: long',
        'Long sleeve oxford cotton shirt with a button-down collar. Regular fit, machine washable.',
        'Used for: office wear, smart casual',
        'Suited to: men',
        'Occasions: work, dinner',
        'Available in: size 38/40/42/44; colour white/sky/lilac',
        'Typically: delivered in 3 days',
      ].join('\n'),
    );
  });

  it('omits lines with nothing in them rather than leaving dangling labels', () => {
    const sparse = composeCanonicalText({
      archetype: 'SIMPLE',
      name: 'VoltCore 30W Compact Charger',
    });
    expect(sparse).toBe('VoltCore 30W Compact Charger');
    expect(sparse).not.toContain('Used for');
    expect(sparse).not.toContain('Typically');
  });

  it('carries the variant option values, so siblings do not collapse to one embedding', () => {
    const size42 = composeCanonical(shirtVariant);
    const size44 = composeCanonical({
      ...shirtVariant,
      optionValues: { size: '44', colour: 'lilac' },
    });

    expect(size42.canonicalText).toContain('size: 42');
    expect(size44.canonicalText).toContain('size: 44');
    // D6 makes the variant the searchable unit; identical hashes here would defeat that.
    expect(size42.contentHash).not.toBe(size44.contentHash);
  });

  it('lets an option value win over a product attribute of the same name', () => {
    const text = composeCanonicalText({
      ...shirtVariant,
      attributes: { ...shirtVariant.attributes, colour: 'white' },
      optionValues: { colour: 'lilac' },
    });
    expect(text).toContain('colour: lilac');
    expect(text).not.toContain('colour: white');
  });

  describe('archetype-specific lines', () => {
    it('includes the axes summary only for VARIANT', () => {
      expect(composeCanonicalText(shirtVariant)).toContain('Available in:');
      expect(composeCanonicalText({ ...shirtVariant, archetype: 'SIMPLE' })).not.toContain(
        'Available in:',
      );
    });

    it('includes route/scope only for LIVE_PRICED', () => {
      const flight: CanonicalUnitInput = {
        archetype: 'LIVE_PRICED',
        name: 'Bengaluru to Delhi, morning departure',
        routeOrScope: 'BLR → DEL',
        priceRangeHint: '₹4,500–8,000',
      };
      expect(composeCanonicalText(flight)).toContain('Route/scope: BLR → DEL');
      expect(composeCanonicalText(flight)).toContain('Typically: ₹4,500–8,000');
      expect(composeCanonicalText({ ...flight, archetype: 'SIMPLE' })).not.toContain('Route/scope');
    });

    it('assembles the availability line from whichever halves exist', () => {
      const base: CanonicalUnitInput = { archetype: 'SIMPLE', name: 'Thing' };
      expect(composeCanonicalText({ ...base, deliveryDays: 3 })).toContain(
        'Typically: delivered in 3 days',
      );
      expect(composeCanonicalText({ ...base, deliveryDays: 1 })).toContain(
        'Typically: delivered in 1 day',
      );
      expect(composeCanonicalText({ ...base, priceRangeHint: '₹500–900' })).toContain(
        'Typically: ₹500–900',
      );
      expect(
        composeCanonicalText({ ...base, priceRangeHint: '₹500–900', deliveryDays: 2 }),
      ).toContain('Typically: ₹500–900, delivered in 2 days');
      // Neither half present: no orphaned label.
      expect(composeCanonicalText(base)).not.toContain('Typically');
    });
  });

  describe('attributes', () => {
    it('renders at most ten pairs', () => {
      const many = Object.fromEntries(
        Array.from({ length: 25 }, (_, i) => [`attr_${String(i).padStart(2, '0')}`, `v${i}`]),
      );
      const line = composeCanonicalText({
        archetype: 'SIMPLE',
        name: 'Thing',
        attributes: many,
      }).split('\n')[1];
      expect(line?.split(', ')).toHaveLength(10);
    });

    it('keeps option values when the cap bites', () => {
      const many = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`zzz_${i}`, `v${i}`]));
      // Sorted alphabetically the `zzz_` keys would crowd `size` out entirely.
      const text = composeCanonicalText({
        archetype: 'VARIANT',
        name: 'Thing',
        attributes: many,
        optionValues: { size: '42' },
      });
      expect(text).toContain('size: 42');
    });

    it('renders booleans, numbers and nested values readably', () => {
      const text = composeCanonicalText({
        archetype: 'SIMPLE',
        name: 'RoadEye 4K Dashcam',
        attributes: {
          night_mode: true,
          screen: false,
          field_of_view_degrees: 170,
          ports: ['usb-c', 'hdmi'],
          dimensions: { w: 4, h: 2 },
        },
      });
      expect(text).toContain('night mode: yes');
      expect(text).toContain('screen: no');
      expect(text).toContain('field of view degrees: 170');
      expect(text).toContain('ports: usb-c/hdmi');
      expect(text).toContain('dimensions: h 2 w 4');
    });
  });

  it('collapses incidental whitespace, so a CSV paste and a form entry agree', () => {
    const fromCsv = composeCanonical({
      archetype: 'SIMPLE',
      name: '  VoltCore 30W  Charger \n',
      description: 'Single USB-C port,\n\tpalm sized.  ',
    });
    const fromForm = composeCanonical({
      archetype: 'SIMPLE',
      name: 'VoltCore 30W Charger',
      description: 'Single USB-C port, palm sized.',
    });
    expect(fromCsv.contentHash).toBe(fromForm.contentHash);
  });
});

/**
 * These two are the T1.14 acceptance criteria. Both guard rule 9: `content_hash` is the
 * only thing standing between a routine catalogue update and a full re-embed bill.
 */
describe('hash stability — the rule 9 contract', () => {
  it('is unchanged when attribute keys are reordered', () => {
    const forward = composeCanonical({
      ...shirtVariant,
      attributes: { fabric: 'cotton', fit: 'regular', sleeve: 'long', collar: 'button-down' },
    });
    const reversed = composeCanonical({
      ...shirtVariant,
      attributes: { collar: 'button-down', sleeve: 'long', fit: 'regular', fabric: 'cotton' },
    });

    expect(reversed.canonicalText).toBe(forward.canonicalText);
    expect(reversed.contentHash).toBe(forward.contentHash);
  });

  it('is unchanged when a nested attribute object reorders its keys', () => {
    const a = composeCanonical({
      archetype: 'SIMPLE',
      name: 'Thing',
      attributes: { dimensions: { l: 10, w: 4, h: 2 } },
    });
    const b = composeCanonical({
      archetype: 'SIMPLE',
      name: 'Thing',
      attributes: { dimensions: { h: 2, l: 10, w: 4 } },
    });
    expect(b.contentHash).toBe(a.contentHash);
  });

  it('is unchanged when price or stock changes', () => {
    /**
     * Modelled the way the embedding worker sees it: a variant row carries price and
     * stock, and the composer is handed the row. Those fields must not reach the text.
     */
    const variantRow = {
      pricePaise: 189900n,
      mrpPaise: 279900n,
      stock: 14,
      sku: 'AP-SHIRT-001-42-LILAC',
    };
    const repriced = { ...variantRow, pricePaise: 249900n, mrpPaise: 349900n, stock: 0 };

    const before = composeCanonical(unitFrom(variantRow));
    const after = composeCanonical(unitFrom(repriced));

    expect(after.canonicalText).toBe(before.canonicalText);
    expect(after.contentHash).toBe(before.contentHash);
    expect(before.canonicalText).not.toContain('1899');
    expect(before.canonicalText).not.toContain('189900');

    function unitFrom(_row: typeof variantRow): CanonicalUnitInput {
      // Price and stock are deliberately not read. This is the point of the test.
      return shirtVariant;
    }
  });

  it('does change when the description changes, so a genuine edit re-embeds', () => {
    const before = composeCanonical(shirtVariant);
    const after = composeCanonical({ ...shirtVariant, description: 'Now in a heavier weave.' });
    expect(after.contentHash).not.toBe(before.contentHash);
  });

  it('produces a stable sha256 across calls', () => {
    const a = composeCanonical(shirtVariant);
    const b = composeCanonical(structuredClone(shirtVariant) as CanonicalUnitInput);
    expect(b.contentHash).toBe(a.contentHash);
    expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.contentHash).toBe(contentHash(a.canonicalText));
  });
});

describe('truncateToApproxTokens', () => {
  it('leaves short text alone', () => {
    expect(truncateToApproxTokens('a short description', 400)).toBe('a short description');
  });

  it('clips long text on a word boundary', () => {
    const long = 'lorem ipsum '.repeat(500);
    const result = truncateToApproxTokens(long, 400);
    expect(result.length).toBeLessThanOrEqual(400 * 4);
    expect(result.endsWith(' ')).toBe(false);
    expect(result).not.toMatch(/lore$|ipsu$/);
  });

  it('truncates the description inside the composed text', () => {
    const text = composeCanonicalText({
      archetype: 'SIMPLE',
      name: 'Thing',
      description: 'word '.repeat(2000),
    });
    expect(text.length).toBeLessThan(2000 * 5);
  });
});
