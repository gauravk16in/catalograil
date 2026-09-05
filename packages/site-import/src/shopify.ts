import type { ExtractedProduct, ExtractedVariant, Fetcher } from './types.js';
import { IMPORT_SLOT } from './types.js';

/**
 * Shopify's own catalogue endpoint, which most Indian D2C stores publish without knowing it.
 *
 * `/products.json` is part of the storefront and returns the catalogue as JSON: names,
 * descriptions, images, every variant with its own price and availability. It is the single
 * highest-yield thing this package can try, and it is exact — no parsing of prose, no
 * guessing which number on a page is the price.
 *
 * Paged deliberately in slots rather than asking for everything: `limit` is capped at 250
 * by Shopify anyway, and a merchant with four thousand products should not have one request
 * decide whether their import works.
 */

interface ShopifyVariant {
  id?: number;
  sku?: string | null;
  title?: string;
  price?: string;
  compare_at_price?: string | null;
  available?: boolean;
  option1?: string | null;
  option2?: string | null;
  option3?: string | null;
}

interface ShopifyProduct {
  id?: number;
  title?: string;
  handle?: string;
  body_html?: string;
  vendor?: string;
  product_type?: string;
  images?: { src?: string }[];
  options?: { name?: string; position?: number }[];
  variants?: ShopifyVariant[];
}

/**
 * Reads one page of the catalogue.
 *
 * Returns `null` — not an empty list — when this is not a Shopify store, because "no
 * products" and "wrong reader" lead to different next steps and a caller that cannot tell
 * them apart will report the wrong one to the merchant.
 */
export async function readShopifyPage(
  origin: string,
  page: number,
  fetch: Fetcher,
): Promise<ExtractedProduct[] | null> {
  const url = `${origin.replace(/\/$/, '')}/products.json?limit=${IMPORT_SLOT}&page=${page}`;

  let response;
  try {
    response = await fetch(url);
  } catch {
    return null;
  }

  if (response.status !== 200) return null;
  if (!response.contentType.includes('json')) return null;

  let parsed: { products?: ShopifyProduct[] };
  try {
    parsed = JSON.parse(response.body) as { products?: ShopifyProduct[] };
  } catch {
    return null;
  }

  // A store that answers 200 with something that is not a product list is not this store.
  if (!Array.isArray(parsed.products)) return null;

  return parsed.products.map((product) => toProduct(product, origin)).filter(isUsable);
}

function toProduct(product: ShopifyProduct, origin: string): ExtractedProduct {
  const handle = product.handle ?? String(product.id ?? '');
  const axisNames = (product.options ?? [])
    .slice()
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((option) => option.name ?? '');

  return {
    // The handle, not the numeric id: it is what the merchant sees in their own admin, so a
    // support conversation about one product can name the same thing on both sides.
    externalRef: `shopify:${handle}`,
    name: (product.title ?? '').trim(),
    ...(product.vendor ? { brand: product.vendor } : {}),
    ...(product.body_html ? { description: stripHtml(product.body_html) } : {}),
    ...(product.product_type ? { categoryHint: product.product_type } : {}),
    images: (product.images ?? []).map((image) => image.src ?? '').filter(Boolean),
    sourceUrl: `${origin.replace(/\/$/, '')}/products/${handle}`,
    variants: (product.variants ?? []).map((variant, index) =>
      toVariant(variant, index, axisNames, handle),
    ),
  };
}

function toVariant(
  variant: ShopifyVariant,
  index: number,
  axisNames: string[],
  handle: string,
): ExtractedVariant {
  const values = [variant.option1, variant.option2, variant.option3];
  const options: Record<string, string> = {};
  axisNames.forEach((name, axis) => {
    const value = values[axis];
    // "Default Title" is Shopify's placeholder for a product with no real options. Carrying
    // it through would put a meaningless axis on every simple product in the catalogue.
    if (name && value && value !== 'Default Title') options[name] = value;
  });

  return {
    /**
     * The merchant's SKU when they set one, otherwise a derived one.
     *
     * Shopify does not require a SKU and plenty of stores leave it blank; `(product, sku)`
     * is unique in our schema, so a blank one would collapse every variant of a product
     * into a single row and quietly discard the rest.
     */
    sku: variant.sku?.trim() || `${handle}-${variant.id ?? index}`,
    options,
    pricePaise: toPaise(variant.price),
    mrpPaise: toPaise(variant.compare_at_price ?? null),
    available: variant.available !== false,
  };
}

/**
 * Rupees as a decimal string to paise as a bigint (rule 13).
 *
 * Deliberately string arithmetic rather than `Number(x) * 100`, which turns 1299.35 into
 * 129934.99999999999 — and a rounding error in a price is not a rounding error, it is a
 * different price than the merchant published.
 */
export function toPaise(amount: string | null | undefined): bigint | null {
  if (!amount) return null;
  const match = /^\s*(-?)(\d+)(?:\.(\d{1,2}))?\s*$/.exec(amount);
  if (!match) return null;
  const [, sign, whole, fraction = ''] = match;
  const paise = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
  return sign === '-' ? -paise : paise;
}

/** Shopify descriptions are HTML. The catalogue stores prose. */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * A product with no name or no priced variant is not importable.
 *
 * Dropping it here rather than at the database is deliberate: the failure is the same
 * either way, but caught here it can be counted and reported as "3 products had no price"
 * instead of arriving as a constraint violation nobody can act on.
 */
function isUsable(product: ExtractedProduct): boolean {
  return product.name !== '' && product.variants.some((v) => v.pricePaise !== null);
}
