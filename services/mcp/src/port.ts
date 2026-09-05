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

  /**
   * T2.7 — acting for a buyer who has connected their account.
   *
   * Each takes the buyer's own access token and forwards it, rather than the MCP server's
   * SigV4 credentials. That is the point: the API decides what this buyer may see from the
   * token, so a bug in the tool layer cannot widen it.
   */
  myAddresses(token: string): Promise<unknown>;
  myOrders(token: string, limit?: number): Promise<unknown>;
  orderStatus(token: string, orderNumber: string): Promise<unknown>;
  placeOrder(token: string, input: PlaceOrderInput): Promise<unknown>;
}

export interface PlaceOrderInput {
  product_id: string;
  variant_id?: string;
  quantity?: number;
  address_id?: string;
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
   * The searchable unit that matched — an identifier for *this result*, not for a variant.
   *
   * D6 makes the variant the searchable unit, so the two are one-to-one for a VARIANT
   * product and it is very easy to assume they are the same value. They are not. This was
   * documented as the thing to pass to `create_checkout`, and doing so found no such
   * variant and answered every purchase with "that product is no longer available".
   */
  id: string;
  /**
   * The variant to buy, or null when the unit is product-level and there is nothing to pick.
   *
   * Separate from `id` deliberately: a caller has to be able to tell "there is no variant"
   * from "I was not given one", and one nullable field says that where an overloaded one
   * cannot.
   */
  variant_id: string | null;
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
