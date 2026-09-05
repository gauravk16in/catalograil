import type { DiscoveryResult, ExtractedProduct, Fetcher } from './types.js';
import { IMPORT_SLOT } from './types.js';
import { readShopifyPage } from './shopify.js';
import { extractProduct } from './jsonld.js';

/**
 * Finding a merchant's products, in order of how well the source can be trusted.
 *
 * Shopify's catalogue endpoint first, because it is exact. Then the sitemap, because a
 * merchant who publishes one has told search engines which URLs are products and there is
 * no better list to be had. Nothing else: a crawler that follows every link on a site is a
 * different and much worse thing to operate, and the marginal store it reaches is one whose
 * pages have no structured data either, so it would arrive with nothing to extract.
 *
 * Everything happens one slot at a time. `offset` is a position in the discovered list, not
 * a page of a crawl, so a merchant with four thousand products imports in eighty bounded
 * pieces and can watch the number climb.
 */

const SITEMAP_PATHS = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap_products_1.xml'];
const MAX_SITEMAPS = 5;
const MAX_URLS = 5_000;

export interface DiscoverOptions {
  /** How many products to return. Never more than a slot. */
  readonly limit?: number;
  /** Where in the discovered list to resume, so the next message continues rather than repeats. */
  readonly offset?: number;
}

export async function discover(
  siteUrl: string,
  fetch: Fetcher,
  options: DiscoverOptions = {},
): Promise<DiscoveryResult> {
  const limit = Math.min(options.limit ?? IMPORT_SLOT, IMPORT_SLOT);
  const offset = options.offset ?? 0;
  const origin = originOf(siteUrl);
  if (!origin) {
    return { method: 'none', products: [], skipped: [], truncated: false };
  }

  /**
   * Shopify pages are 1-based and sized to the slot, so an offset maps to a page directly
   * and no request fetches products that are about to be thrown away.
   */
  const page = Math.floor(offset / IMPORT_SLOT) + 1;
  const shopify = await readShopifyPage(origin, page, fetch);
  if (shopify !== null) {
    return {
      method: 'shopify',
      products: shopify.slice(0, limit),
      skipped: [],
      // A full page means there is probably another. Asking for one more product to find
      // out would cost a request per slot for the whole catalogue.
      truncated: shopify.length >= IMPORT_SLOT,
    };
  }

  const urls = await productUrls(origin, fetch);
  const slice = urls.slice(offset, offset + limit);
  const products: ExtractedProduct[] = [];
  const skipped: { url: string; reason: string }[] = [];

  for (const url of slice) {
    let page;
    try {
      page = await fetch(url);
    } catch (err) {
      skipped.push({ url, reason: err instanceof Error ? err.message : 'could not be fetched' });
      continue;
    }

    if (page.status !== 200 || !page.contentType.includes('html')) {
      skipped.push({ url, reason: `returned ${page.status}` });
      continue;
    }

    const product = extractProduct(page.body, url);
    if (product) products.push(product);
    else {
      // Named plainly, because it is fixable and the merchant is the only one who can fix
      // it: a store with product markup gets imported, one without does not.
      skipped.push({ url, reason: 'no product data (schema.org Product markup) on the page' });
    }
  }

  return {
    method: products.length > 0 ? 'json-ld' : 'none',
    products,
    skipped,
    truncated: offset + limit < urls.length,
  };
}

/**
 * Product URLs from the sitemap.
 *
 * Sitemap indexes are followed one level and no further, capped, because a site that
 * nests them deeper is a site whose import should be a conversation rather than a crawl.
 */
async function productUrls(origin: string, fetch: Fetcher): Promise<string[]> {
  for (const path of SITEMAP_PATHS) {
    const found = await readSitemap(`${origin}${path}`, fetch, 0);
    if (found.length > 0) return found.slice(0, MAX_URLS);
  }
  return [];
}

async function readSitemap(url: string, fetch: Fetcher, depth: number): Promise<string[]> {
  if (depth > 1) return [];

  let page;
  try {
    page = await fetch(url);
  } catch {
    return [];
  }
  if (page.status !== 200) return [];

  const locations = [...page.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]!);

  // An index points at more sitemaps rather than at pages.
  if (/<sitemapindex/i.test(page.body)) {
    const nested = locations.filter(looksLikeProductSitemap).slice(0, MAX_SITEMAPS);
    const all: string[] = [];
    for (const child of nested) all.push(...(await readSitemap(child, fetch, depth + 1)));
    return all;
  }

  return locations.filter(looksLikeProduct);
}

/**
 * Which URLs are worth fetching.
 *
 * A blunt filter on the path, and deliberately so: fetching a merchant's entire blog to
 * discover it is a blog costs them nothing and costs us a page each. The words below are
 * what the common platforms actually use.
 */
function looksLikeProduct(url: string): boolean {
  return /\/(products?|item|shop|collections\/[^/]+\/products|p)\//i.test(url);
}

function looksLikeProductSitemap(url: string): boolean {
  return /product|item|shop/i.test(url) || /sitemap[-_]?\d*\.xml/i.test(url);
}

/** The origin, or null if this is not something we should be fetching at all. */
export function originOf(siteUrl: string): string | null {
  const candidate = /^https?:\/\//i.test(siteUrl) ? siteUrl : `https://${siteUrl}`;
  try {
    const parsed = new URL(candidate);
    // http is accepted for the redirect it usually is; anything else is not a website.
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}
