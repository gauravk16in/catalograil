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
  /** The variant, which is what gets bought. */
  id: string;
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
