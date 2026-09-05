import type { ParsedProduct, ParsedVariant } from '@catalograil/core';
import type { ExtractedProduct } from './types.js';

/**
 * Extracted products, in the shape the catalogue already accepts.
 *
 * Converting here rather than writing a second insert path is the point: a site import and
 * a CSV upload land through the same `upsertProduct`, so they cannot drift into producing
 * subtly different products — and everything downstream (enrichment, embedding, the search
 * index) needs no knowledge that this source exists.
 */
export function toParsedProducts(products: readonly ExtractedProduct[]): ParsedProduct[] {
  return products.map((product, index) => {
    const variants = product.variants
      .filter((variant) => variant.pricePaise !== null)
      .map<ParsedVariant>((variant, position) => ({
        sku: variant.sku,
        optionValues: variant.options,
        pricePaise: variant.pricePaise!,
        ...(variant.mrpPaise !== null ? { mrpPaise: variant.mrpPaise } : {}),
        /**
         * Stock is a flag on the source, not a count.
         *
         * A store's public pages say "in stock", never "seven left". Importing 1 for
         * available is the honest reading: it lets the product be bought once and forces the
         * merchant to state a real number before it can be bought twice. Importing a made-up
         * 100 would oversell them on day one.
         */
        stock: variant.available ? 1 : 0,
        images: [],
        // Not a CSV, so there is no line. The position keeps error messages orderable.
        sourceRow: position + 1,
      }));

    const axes = axesOf(product);

    return {
      externalRef: product.externalRef,
      /**
       * VARIANT only when there is genuinely more than one thing to pick.
       *
       * The archetype drives the MCP response shape and the checkout flow, so a simple
       * product declared VARIANT asks a buyer to choose from a list of one.
       */
      archetype: axes.length > 0 ? 'VARIANT' : 'SIMPLE',
      name: product.name,
      ...(product.brand ? { brand: product.brand } : {}),
      ...(product.description ? { description: product.description } : {}),
      ...(product.categoryHint ? { categoryHint: product.categoryHint } : {}),
      images: product.images,
      optionAxes: axes,
      variants,
      sourceRow: index + 1,
    };
  });
}

/** The axes actually used, in first-seen order, with each value seen once. */
function axesOf(product: ExtractedProduct): { name: string; values: string[] }[] {
  const axes = new Map<string, string[]>();
  for (const variant of product.variants) {
    for (const [name, value] of Object.entries(variant.options)) {
      const values = axes.get(name) ?? [];
      if (!values.includes(value)) values.push(value);
      axes.set(name, values);
    }
  }
  return [...axes].map(([name, values]) => ({ name, values }));
}
