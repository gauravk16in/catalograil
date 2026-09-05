/**
 * Importing a merchant's catalogue from the website they already maintain.
 *
 * The alternative is a CSV, and a CSV is a wall: a merchant who has already listed two
 * hundred products on their own store is being asked to export, reformat and re-upload
 * them before Conciergent is worth anything to them. Most never finish. Their site already
 * has the answer, and for a large share of Indian D2C stores it is available in a form
 * meant to be read by machines.
 *
 * This package does the reading and nothing else — no network policy, no database, no
 * queue. It takes a fetcher and gives back products, so the awkward parts (a store that
 * lies about its platform, a page with three conflicting prices) are testable without
 * standing anything up.
 */

export interface FetchedPage {
  readonly url: string;
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

/**
 * How this package reaches the network.
 *
 * Injected rather than calling `fetch` directly: the worker's fetcher enforces the timeout,
 * the redirect limit, the response size cap and the refusal to touch private address
 * ranges. None of that belongs in an extractor, and all of it has to be somewhere.
 */
export type Fetcher = (url: string) => Promise<FetchedPage>;

export interface ExtractedVariant {
  /** The merchant's own identifier, kept so a re-import updates rather than duplicates. */
  readonly sku: string;
  readonly options: Record<string, string>;
  readonly pricePaise: bigint | null;
  readonly mrpPaise: bigint | null;
  readonly available: boolean;
}

export interface ExtractedProduct {
  /**
   * Stable across imports, derived from the merchant's own handle or the product URL.
   *
   * This is what makes a second import an update: `(merchant_id, external_ref)` is the
   * match key, so an id derived from anything incidental — a position in a list, the time
   * of the run — would silently duplicate the whole catalogue on every re-import.
   */
  readonly externalRef: string;
  readonly name: string;
  readonly brand?: string;
  readonly description?: string;
  readonly categoryHint?: string;
  readonly images: string[];
  readonly sourceUrl: string;
  readonly variants: ExtractedVariant[];
}

export interface DiscoveryResult {
  /** Which reader found these, which is worth reporting: it explains what was missed. */
  readonly method: 'shopify' | 'json-ld' | 'none';
  readonly products: ExtractedProduct[];
  /** Product pages seen but not understood, so a merchant learns what to fix. */
  readonly skipped: { url: string; reason: string }[];
  /** True when the source has more than was read in this pass. */
  readonly truncated: boolean;
}

/**
 * The slot size, and the reason the whole import is shaped around one.
 *
 * Fifty products is the unit of work everywhere downstream: fifty pages fetched, fifty rows
 * written, one queue message for the next fifty. It keeps a Lambda invocation bounded
 * whether a merchant has forty products or four thousand, it keeps a failure to fifty
 * products rather than to the catalogue, and it gives the merchant a progress number that
 * moves instead of a spinner that does not.
 */
export const IMPORT_SLOT = 50;
