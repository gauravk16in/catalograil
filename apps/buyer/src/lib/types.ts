/**
 * What a search result is, in one place.
 *
 * It lived in the page component, which meant every card, panel and checkout imported a
 * page to learn the shape of a product. Two things are shown here that a conventional
 * storefront omits, and both are deliberate: every price carries when it was last known
 * true (rule 7), and every result says why it matched — because a buyer being answered by
 * software has no way to check either otherwise.
 */
export interface SearchResultItem {
  /**
   * The searchable unit, which is what got matched — **not** a variant id.
   *
   * D6 makes the variant the searchable unit, so the two are one-to-one for a VARIANT
   * product and it is easy to assume they are the same value. They are not, and passing
   * this one to checkout produced "That product is no longer available" on every purchase.
   * Use it as a React key, nothing more.
   */
  id: string;
  /** The variant that gets bought, when the unit has one. Absent for product-level units. */
  variantId?: string;
  /** The product, which is what gets asked about. */
  productId: string;
  name: string;
  brand?: string;
  displayPrice?: string;
  pricePaise?: string;
  priceAsOf: string;
  availability: 'in_stock' | 'out_of_stock' | 'unknown';
  deliveryEstimate?: string;
  options?: Record<string, string>;
  images: string[];
  whyThisMatched: string;
  merchant: {
    id: string;
    name: string;
    city?: string;
    trust: { score: number; newMerchant: boolean; signals: string[] };
  };
}

export interface SearchResponse {
  results: SearchResultItem[];
  /** Rule 8: a sentence stating why, so nothing has to be invented to fill the silence. */
  noResultsReason?: string;
  tookMs: number;
}
