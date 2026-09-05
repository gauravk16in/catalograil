import { describe, expect, it } from 'vitest';
import { PRODUCT_WIDGET_URI, renderWidget, widgetResources } from './widget.js';

const RESULT = {
  results: [
    {
      id: 'variant-1',
      product_id: 'product-1',
      name: 'HP 15 15.6" Core i5',
      brand: 'HP',
      display_price: '₹59,999',
      price_as_of: '2026-09-05T12:00:00Z',
      availability: 'in stock',
      delivery_estimate: 'delivers in 4 days',
      merchant: { id: 'm1', name: 'Newme', trust: { score: 0, new_merchant: true, signals: [] } },
      image_url: 'https://example.test/hp15.jpg',
      product_url: 'https://buy.test/p/product-1',
    },
  ],
};

describe('the product widget', () => {
  it('ships the data inside the document for clients that render it inline', () => {
    const html = renderWidget(RESULT);
    expect(html).toContain('id="seed"');
    expect(html).toContain('https://example.test/hp15.jpg');
    expect(html).toContain('₹59,999');
  });

  it('ships no data in the template ChatGPT fetches before any tool has run', () => {
    const html = renderWidget(null);
    expect(html).not.toContain('id="seed"');
    // It has to be able to find the data later, or it renders an empty box forever.
    expect(html).toContain('window.openai');
  });

  it('cannot be closed out of by a product name', () => {
    const html = renderWidget({ results: [{ name: '</script><script>alert(1)</script>' }] });
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('\\u003c/script>');
  });

  it('declares the URI the tool meta points at', () => {
    expect(widgetResources()[0]!.uri).toBe(PRODUCT_WIDGET_URI);
  });
});
