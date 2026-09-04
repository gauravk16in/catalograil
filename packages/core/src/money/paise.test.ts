import { describe, expect, it } from 'vitest';
import { formatPaise, rupeeStringToPaise, rupeesToPaise, sumPaise } from './paise.js';

describe('rupeeStringToPaise', () => {
  it('parses whole and decimal rupees exactly', () => {
    expect(rupeeStringToPaise('2499')).toBe(249900n);
    expect(rupeeStringToPaise('2499.50')).toBe(249950n);
    expect(rupeeStringToPaise('2499.5')).toBe(249950n);
    expect(rupeeStringToPaise('0.01')).toBe(1n);
  });

  it('strips rupee symbols and separators', () => {
    expect(rupeeStringToPaise('₹1,24,999.99')).toBe(12499999n);
  });

  it('does not lose precision the way a float would', () => {
    // 0.1 + 0.2 !== 0.3 in float; in paise it is exact.
    expect(rupeeStringToPaise('0.10') + rupeeStringToPaise('0.20')).toBe(
      rupeeStringToPaise('0.30'),
    );
  });

  it('rejects malformed input', () => {
    expect(() => rupeeStringToPaise('2499.999')).toThrow(/valid rupee amount/);
    expect(() => rupeeStringToPaise('abc')).toThrow();
    expect(() => rupeeStringToPaise('')).toThrow();
  });
});

describe('rupeesToPaise', () => {
  it('converts whole rupees', () => {
    expect(rupeesToPaise(2499)).toBe(249900n);
  });

  it('refuses a fractional number so floats never enter a money path', () => {
    expect(() => rupeesToPaise(2499.5)).toThrow();
  });
});

describe('formatPaise', () => {
  it('uses Indian digit grouping', () => {
    expect(formatPaise(249900n)).toBe('₹2,499');
    expect(formatPaise(12499999n)).toBe('₹1,24,999.99');
    expect(formatPaise(100000000n)).toBe('₹10,00,000');
    expect(formatPaise(99n)).toBe('₹0.99');
  });

  it('omits the symbol on request and handles negatives', () => {
    expect(formatPaise(249900n, { symbol: false })).toBe('2,499');
    expect(formatPaise(-249950n)).toBe('-₹2,499.50');
  });
});

describe('sumPaise', () => {
  it('totals line amounts in bigint', () => {
    expect(sumPaise([249900n, 15000n, 4499n])).toBe(269399n);
    expect(sumPaise([])).toBe(0n);
  });
});
