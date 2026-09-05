import { describe, expect, it } from 'vitest';
import { discover, extractProduct, originOf, readShopifyPage, toPaise, toParsedProducts } from './index.js';
import type { FetchedPage, Fetcher } from './types.js';

function serve(pages: Record<string, Partial<FetchedPage>>): Fetcher {
  return async (url) => {
    const page = pages[url];
    if (!page) return { url, status: 404, contentType: 'text/html', body: '' };
    return { url, status: 200, contentType: 'text/html', body: '', ...page };
  };
}

const SHOPIFY = {
  products: [
    {
      id: 1,
      title: 'Oxford Cotton Shirt',
      handle: 'oxford-cotton-shirt',
      vendor: 'Meridian',
      product_type: 'Shirts',
      body_html: '<p>Full-sleeve <b>oxford</b> cotton.</p>',
      images: [{ src: 'https://cdn.test/shirt.jpg' }],
      options: [{ name: 'Size', position: 1 }],
      variants: [
        { id: 11, sku: 'MER-OX-38', option1: '38', price: '1999.00', compare_at_price: '2499.00', available: true },
        { id: 12, sku: '', option1: '40', price: '1999.00', available: false },
      ],
    },
  ],
};

describe('reading a Shopify catalogue', () => {
  const fetch = serve({
    'https://store.test/products.json?limit=50&page=1': {
      contentType: 'application/json',
      body: JSON.stringify(SHOPIFY),
    },
  });

  it('reads names, prices, images and per-variant availability', async () => {
    const products = await readShopifyPage('https://store.test', 1, fetch);
    const product = products![0]!;

    expect(product.name).toBe('Oxford Cotton Shirt');
    expect(product.brand).toBe('Meridian');
    expect(product.images).toEqual(['https://cdn.test/shirt.jpg']);
    expect(product.variants[0]!.pricePaise).toBe(199900n);
    expect(product.variants[0]!.mrpPaise).toBe(249900n);
    expect(product.variants[1]!.available).toBe(false);
  });

  it('gives a variant with no SKU one of its own', () => {
    // `(product, sku)` is unique, so blank SKUs would collapse every variant into one row.
    return readShopifyPage('https://store.test', 1, fetch).then((products) => {
      expect(products![0]!.variants[1]!.sku).toBe('oxford-cotton-shirt-12');
    });
  });

  it('is not confused by a site that answers 200 with something else', async () => {
    const html = serve({
      'https://blog.test/products.json?limit=50&page=1': { body: '<html>Not found</html>' },
    });
    // null, not [] — "wrong reader" and "no products" lead to different next steps.
    expect(await readShopifyPage('https://blog.test', 1, html)).toBeNull();
  });
});

describe('prices', () => {
  it('converts rupees to paise without going through a float', () => {
    // Number('1299.35') * 100 is 129934.99999999999, and a wrong price is what a buyer pays.
    expect(toPaise('1299.35')).toBe(129935n);
    expect(toPaise('1999')).toBe(199900n);
    expect(toPaise('0.05')).toBe(5n);
  });

  it('refuses anything that is not a plain amount', () => {
    expect(toPaise('₹1,999')).toBeNull();
    expect(toPaise('call for price')).toBeNull();
    expect(toPaise(null)).toBeNull();
  });
});

describe('reading schema.org markup', () => {
  const page = (product: unknown) =>
    `<html><head><script type="application/ld+json">${JSON.stringify(product)}</script></head></html>`;

  it('extracts a product from a @graph, which is what SEO plugins emit', () => {
    const html = page({
      '@graph': [
        { '@type': 'WebPage', name: 'Shirt page' },
        {
          '@type': 'Product',
          name: 'Linen Kurta',
          description: 'Handwoven.',
          image: '/img/kurta.jpg',
          offers: { price: '2499.00', priceCurrency: 'INR', availability: 'https://schema.org/InStock' },
        },
      ],
    });

    const product = extractProduct(html, 'https://store.test/products/linen-kurta')!;
    expect(product.name).toBe('Linen Kurta');
    expect(product.variants[0]!.pricePaise).toBe(249900n);
    // Relative image paths resolved against the page, or nothing can display them.
    expect(product.images).toEqual(['https://store.test/img/kurta.jpg']);
    expect(product.externalRef).toBe('site:products/linen-kurta');
  });

  it('refuses a price in another currency rather than importing it as rupees', () => {
    const html = page({
      '@type': 'Product',
      name: 'Imported Jacket',
      offers: { price: '120.00', priceCurrency: 'USD' },
    });
    // Off by a factor of eighty, plausible-looking, and nothing downstream would catch it.
    expect(extractProduct(html, 'https://store.test/p/jacket')).toBeNull();
  });

  it('returns nothing rather than guessing when there is no markup', () => {
    expect(extractProduct('<html><body>₹2,499 Buy now</body></html>', 'https://x.test/p/1')).toBeNull();
  });

  it('survives one malformed block among several', () => {
    const html =
      '<script type="application/ld+json">{ not json </script>' +
      page({ '@type': 'Product', name: 'Steel Bottle', offers: { price: '499' } });
    expect(extractProduct(html, 'https://x.test/p/bottle')!.name).toBe('Steel Bottle');
  });
});

describe('discovery', () => {
  it('prefers the platform endpoint and reports which one it used', async () => {
    const result = await discover(
      'store.test',
      serve({
        'https://store.test/products.json?limit=50&page=1': {
          contentType: 'application/json',
          body: JSON.stringify(SHOPIFY),
        },
      }),
    );
    expect(result.method).toBe('shopify');
    expect(result.products).toHaveLength(1);
  });

  it('falls back to the sitemap, and names the pages it could not read', async () => {
    const result = await discover(
      'https://shop.test',
      serve({
        'https://shop.test/sitemap.xml': {
          contentType: 'application/xml',
          body: `<urlset>
            <url><loc>https://shop.test/products/lamp</loc></url>
            <url><loc>https://shop.test/products/rug</loc></url>
            <url><loc>https://shop.test/blog/how-we-weave</loc></url>
          </urlset>`,
        },
        'https://shop.test/products/lamp': {
          body: `<script type="application/ld+json">${JSON.stringify({
            '@type': 'Product',
            name: 'Brass Lamp',
            offers: { price: '3200', priceCurrency: 'INR' },
          })}</script>`,
        },
        'https://shop.test/products/rug': { body: '<html>no markup here</html>' },
      }),
    );

    expect(result.method).toBe('json-ld');
    expect(result.products.map((p) => p.name)).toEqual(['Brass Lamp']);
    // The blog post was never fetched: a URL filter costs nothing, a page costs a request.
    expect(result.skipped.map((s) => s.url)).toEqual(['https://shop.test/products/rug']);
    expect(result.skipped[0]!.reason).toContain('schema.org');
  });

  it('never returns more than a slot, whatever it is asked for', async () => {
    const many = { products: Array.from({ length: 80 }, (_, i) => ({
      id: i,
      title: `Item ${i}`,
      handle: `item-${i}`,
      variants: [{ id: i, sku: `S${i}`, price: '100.00', available: true }],
    })) };

    const result = await discover(
      'store.test',
      serve({
        'https://store.test/products.json?limit=50&page=1': {
          contentType: 'application/json',
          body: JSON.stringify(many),
        },
      }),
      { limit: 500 },
    );

    expect(result.products.length).toBeLessThanOrEqual(50);
    expect(result.truncated).toBe(true);
  });

  it('resumes at an offset instead of re-reading from the start', async () => {
    const calls: string[] = [];
    const fetch: Fetcher = async (url) => {
      calls.push(url);
      return { url, status: 404, contentType: 'text/html', body: '' };
    };
    await discover('store.test', fetch, { offset: 100 });
    // Offset 100 is Shopify's page 3, not page 1 read three times.
    expect(calls[0]).toContain('page=3');
  });

  it('refuses something that is not a website', async () => {
    expect(originOf('javascript:alert(1)')).toBeNull();
    expect(originOf('not a url at all')).toBeNull();
    expect(originOf('store.test')).toBe('https://store.test');
  });
});

describe('conversion into catalogue products', () => {
  it('declares VARIANT only when there is more than one thing to pick', async () => {
    const products = await readShopifyPage(
      'https://store.test',
      1,
      serve({
        'https://store.test/products.json?limit=50&page=1': {
          contentType: 'application/json',
          body: JSON.stringify(SHOPIFY),
        },
      }),
    );

    const [parsed] = toParsedProducts(products!);
    expect(parsed!.archetype).toBe('VARIANT');
    expect(parsed!.optionAxes).toEqual([{ name: 'Size', values: ['38', '40'] }]);
  });

  it('imports availability as one, not as an invented count', () => {
    const [parsed] = toParsedProducts([
      {
        externalRef: 'x',
        name: 'Thing',
        images: [],
        sourceUrl: 'https://x.test/p/1',
        variants: [
          { sku: 'a', options: {}, pricePaise: 100n, mrpPaise: null, available: true },
          { sku: 'b', options: {}, pricePaise: 100n, mrpPaise: null, available: false },
        ],
      },
    ]);

    // A public page says "in stock", never "seven left". Importing 100 would oversell them.
    expect(parsed!.variants[0]!.stock).toBe(1);
    expect(parsed!.variants[1]!.stock).toBe(0);
    expect(parsed!.archetype).toBe('SIMPLE');
  });
});
