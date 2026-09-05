/**
 * What the MCP tools need from the catalogue, and nothing more.
 *
 * An interface rather than a direct import of the API client, so the tools can be tested
 * against a fake without a network, a database or AWS credentials — and so the transport
 * wiring in `handler.ts` stays separable from what the tools actually mean.
 */
export interface CatalogPort {
  search(input: SearchInput): Promise<SearchResponse>;
  getProduct(input: { product_id: string; pincode?: string }): Promise<unknown>;
  compare(input: { product_ids: string[] }): Promise<ComparisonResponse>;
  getPolicies(input: { merchant_id: string }): Promise<unknown>;
  createCheckout(input: CheckoutInput): Promise<unknown>;
}

export interface SearchInput {
  query?: string;
  image_url?: string;
  max_price_inr?: number;
  min_price_inr?: number;
  category?: string;
  delivery_by_days?: number;
  pincode?: string;
  attributes?: Record<string, string>;
  in_stock_only?: boolean;
  limit?: number;
}

export interface CheckoutInput {
  product_id: string;
  variant_id?: string;
  quantity?: number;
  buyer_email?: string;
}

export interface McpResult {
  /**
   * The variant, which is what gets bought. Pass this to `create_checkout`.
   *
   * D6 makes the variant the searchable unit, so a search for "size 42" matches the size-42
   * row rather than the product that stocks it.
   */
  id: string;
  /**
   * The product, which is what gets asked about. Pass this to `get_product` and
   * `compare_products`.
   *
   * Both ids are returned because a model chaining the tools has no way to derive one from
   * the other, and returning only `id` made every `get_product` call after a search fail on
   * a UUID that was real but was not a product.
   */
  product_id: string;
  name: string;
  brand: string | null;
  display_price: string | null;
  price_paise: string | null;
  /** Rule 7: no price without the moment it was true. */
  price_as_of: string;
  availability: string;
  availability_as_of: string;
  delivery_estimate: string | null;
  options: Record<string, string>;
  why_this_matched: string;
  merchant: {
    id: string;
    name: string;
    trust: { score: number; new_merchant: boolean; signals: string[] };
  };
  image_url: string | null;
  product_url: string | null;
}

export interface SearchResponse {
  results: McpResult[];
  /** Rule 8: a sentence the model can state as fact instead of inventing one. */
  no_results_reason?: string;
}

export interface ComparisonResponse {
  items: { id: string; name: string; attributes: Record<string, unknown> }[];
  /** Every key any item has, so the model can render aligned rows. */
  attribute_keys: string[];
  /** Only the keys where values actually diverge. */
  differences: string[];
}
