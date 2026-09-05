import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toJsonSchema } from './handler.js';
import { getProductSchema, searchProductsSchema, placeOrderSchema } from './tools.js';

/**
 * Regression for a real failure: Claude called `search_products` and the connector errored.
 *
 * The payload is copied verbatim from that call. Every value arrived as a **string** —
 * `limit: "5"`, `in_stock_only: "true"` — and every optional the model chose not to use
 * arrived as `""` rather than being omitted. A strict schema rejects all of it, and the
 * buyer sees a broken connector.
 */
const CLAUDE_PAYLOAD = {
  limit: '5',
  query: 'wireless earbuds',
  pincode: '560001',
  category: '',
  image_url: '',
  in_stock_only: 'true',
  max_price_inr: '',
  min_price_inr: '',
  delivery_by_days: '',
};

describe('tool argument coercion', () => {
  it('accepts the exact payload that broke the connector', () => {
    const parsed = z.object(searchProductsSchema).parse(CLAUDE_PAYLOAD);
    expect(parsed.query).toBe('wireless earbuds');
    expect(parsed.limit).toBe(5);
    expect(parsed.in_stock_only).toBe(true);
    expect(parsed.pincode).toBe('560001');
  });

  it('treats an empty string as "not given", not as a value', () => {
    // The distinction matters: `image_url: ""` is not a URL the buyer supplied, and
    // `max_price_inr: ""` is not a budget of zero.
    const parsed = z.object(searchProductsSchema).parse(CLAUDE_PAYLOAD);
    expect(parsed.image_url).toBeUndefined();
    expect(parsed.max_price_inr).toBeUndefined();
    expect(parsed.category).toBeUndefined();
    expect(parsed.delivery_by_days).toBeUndefined();
  });

  it('still accepts correctly typed JSON', () => {
    // ChatGPT and the MCP inspector do send real types; coercion must not break them.
    const parsed = z.object(searchProductsSchema).parse({
      query: 'shirt',
      limit: 3,
      in_stock_only: false,
      max_price_inr: 2500,
    });
    expect(parsed.limit).toBe(3);
    expect(parsed.in_stock_only).toBe(false);
    expect(parsed.max_price_inr).toBe(2500);
  });

  it('caps the limit at five however it arrives', () => {
    // Rule 6 holds against a string too.
    expect(() => z.object(searchProductsSchema).parse({ query: 'x', limit: '50' })).toThrow();
  });

  it('still rejects a value that is genuinely wrong', () => {
    // Tolerating string-typed numbers must not become tolerating nonsense.
    expect(() =>
      z.object(searchProductsSchema).parse({ query: 'x', max_price_inr: 'cheap' }),
    ).toThrow();
    expect(() =>
      z.object(searchProductsSchema).parse({ query: 'x', image_url: 'not-a-url' }),
    ).toThrow();
  });

  it('coerces the ordering tools too, since they take ids and quantities', () => {
    const parsed = z.object(placeOrderSchema).parse({
      product_id: '3a534e33-b80b-42fc-892c-93112fbd998e',
      variant_id: '',
      quantity: '2',
      address_id: '',
    });
    expect(parsed.quantity).toBe(2);
    expect(parsed.variant_id).toBeUndefined();
    expect(parsed.address_id).toBeUndefined();
  });
});

/**
 * The coercion above is a safety net. This is the thing that was actually wrong: what the
 * tool list *tells* the model to send.
 */
describe('advertised JSON Schema', () => {
  const search = toJsonSchema(z.object(searchProductsSchema)) as {
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };

  it('gives every field its real type, not string', () => {
    expect(search.properties.limit.type).toBe('number');
    expect(search.properties.max_price_inr.type).toBe('number');
    expect(search.properties.in_stock_only.type).toBe('boolean');
    expect(search.properties.query.type).toBe('string');
    expect(search.properties.attributes.type).toBe('object');
  });

  it('marks nothing on search as required, because nothing is', () => {
    expect(search.required ?? []).toEqual([]);
  });

  it('still marks a genuinely required field as required', () => {
    const getProduct = toJsonSchema(z.object(getProductSchema)) as { required?: string[] };
    expect(getProduct.required).toEqual(['product_id']);
  });

  it('keeps the descriptions, which are what drive tool selection', () => {
    expect(search.properties.delivery_by_days.description).toContain('excluded');
  });
});
