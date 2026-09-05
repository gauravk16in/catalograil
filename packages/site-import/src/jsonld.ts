import type { ExtractedProduct, ExtractedVariant } from './types.js';
import { stripHtml, toPaise } from './shopify.js';

/**
 * schema.org `Product`, embedded in the page by almost every store that wants to appear in
 * Google Shopping — which is almost every store.
 *
 * This is the second-best source after a platform API and far better than reading the page
 * itself: it is the merchant's own structured statement of what the product is and what it
 * costs. Where it is absent, this package gives up on that page rather than guessing, and
 * says so. A price scraped out of prose is a price that will eventually be wrong, and a
 * wrong price is not a cosmetic bug here — it is what the buyer is charged.
 */

interface JsonLdOffer {
  price?: string | number;
  priceCurrency?: string;
  availability?: string;
  sku?: string;
  name?: string;
}

interface JsonLdProduct {
  '@type'?: string | string[];
  name?: string;
  description?: string;
  sku?: string;
  brand?: string | { name?: string };
  category?: string;
  image?: string | string[] | { url?: string }[];
  offers?: JsonLdOffer | JsonLdOffer[];
}

/** Every `<script type="application/ld+json">` block, parsed, bad ones skipped. */
export function readJsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  const pattern = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    try {
      blocks.push(JSON.parse(match[1]!.trim()));
    } catch {
      // A malformed block on a page with three of them should not lose the other two.
    }
  }
  return blocks;
}

/**
 * The product on one page, or null.
 *
 * `@graph` and bare arrays are both handled because both are common: Yoast and most WordPress
 * SEO plugins emit a graph, hand-rolled markup usually emits one object, and neither is
 * wrong.
 */
export function extractProduct(html: string, pageUrl: string): ExtractedProduct | null {
  for (const block of readJsonLdBlocks(html)) {
    const found = findProduct(block);
    if (found) {
      const product = toProduct(found, pageUrl);
      if (product) return product;
    }
  }
  return null;
}

function findProduct(node: unknown, depth = 0): JsonLdProduct | null {
  if (depth > 4 || node === null || typeof node !== 'object') return null;

  if (Array.isArray(node)) {
    for (const entry of node) {
      const found = findProduct(entry, depth + 1);
      if (found) return found;
    }
    return null;
  }

  const record = node as Record<string, unknown>;
  const type = record['@type'];
  const types = Array.isArray(type) ? type : [type];
  if (types.some((t) => typeof t === 'string' && t.toLowerCase() === 'product')) {
    return record as JsonLdProduct;
  }

  const graph = record['@graph'];
  if (Array.isArray(graph)) return findProduct(graph, depth + 1);
  return null;
}

function toProduct(node: JsonLdProduct, pageUrl: string): ExtractedProduct | null {
  const name = (node.name ?? '').trim();
  if (!name) return null;

  const offers = Array.isArray(node.offers) ? node.offers : node.offers ? [node.offers] : [];
  const variants = offers
    .map((offer, index) => toVariant(offer, index, offers.length, node, pageUrl))
    .filter((v): v is ExtractedVariant => v !== null);

  if (variants.length === 0) return null;

  const brand = typeof node.brand === 'string' ? node.brand : node.brand?.name;

  return {
    /**
     * The page's own URL path, which is the only identifier a generic page reliably has.
     *
     * A `sku` would be better and is often missing; the path is stable for as long as the
     * merchant's URLs are, and a merchant who changes their URLs has changed the identity
     * of the page as far as everything else on the web is concerned too.
     */
    externalRef: `site:${externalRefFor(pageUrl)}`,
    name,
    ...(brand ? { brand } : {}),
    ...(node.description ? { description: stripHtml(node.description) } : {}),
    ...(node.category ? { categoryHint: node.category } : {}),
    images: toImages(node.image, pageUrl),
    sourceUrl: pageUrl,
    variants,
  };
}

function toVariant(
  offer: JsonLdOffer,
  index: number,
  total: number,
  node: JsonLdProduct,
  pageUrl: string,
): ExtractedVariant | null {
  const price = toPaise(typeof offer.price === 'number' ? offer.price.toFixed(2) : offer.price);
  if (price === null) return null;

  /**
   * Currency is checked, not assumed.
   *
   * A store listing in USD would otherwise import as rupees — the number would look
   * plausible, the price would be off by a factor of eighty, and nothing downstream would
   * notice until a buyer paid it.
   */
  if (offer.priceCurrency && offer.priceCurrency.toUpperCase() !== 'INR') return null;

  const availability = (offer.availability ?? '').toLowerCase();

  return {
    sku: (offer.sku ?? node.sku ?? `${externalRefFor(pageUrl)}-${index}`).trim(),
    /**
     * A generic page carries no option axes, only a list of offers. Where there is more
     * than one, the offer's own name is the only thing distinguishing them and is worth
     * keeping; where there is one, an axis called "variant" with a single value is noise
     * the merchant then has to look at on every simple product they own.
     */
    options: total > 1 && offer.name ? { variant: offer.name } : {},
    pricePaise: price,
    mrpPaise: null,
    // Absent availability means in stock: schema.org treats it as optional and most stores
    // omit it on pages they are actively selling from.
    available: availability === '' || availability.includes('instock'),
  };
}

function toImages(image: JsonLdProduct['image'], pageUrl: string): string[] {
  const raw = Array.isArray(image) ? image : image ? [image] : [];
  return raw
    .map((entry) => (typeof entry === 'string' ? entry : (entry?.url ?? '')))
    .filter(Boolean)
    .map((src) => absolute(src, pageUrl));
}

function absolute(src: string, base: string): string {
  try {
    return new URL(src, base).toString();
  } catch {
    return src;
  }
}

/** The path, trimmed — short enough to read in a support conversation, stable enough to match on. */
export function externalRefFor(pageUrl: string): string {
  try {
    return new URL(pageUrl).pathname.replace(/^\/+|\/+$/g, '') || 'index';
  } catch {
    return pageUrl;
  }
}
