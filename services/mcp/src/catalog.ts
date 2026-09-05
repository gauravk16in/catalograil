import { AppError } from '@catalograil/core';
import type {
  CatalogPort,
  CheckoutInput,
  ComparisonResponse,
  McpResult,
  PlaceOrderInput,
  SearchInput,
  SearchResponse,
} from './port.js';

/**
 * The catalogue, over the internal API.
 *
 * Requests are SigV4-signed by the Lambda's own role — `/internal/*` is machine-to-machine,
 * and the MCP server is a machine. It calls the same endpoint the merchant preview calls,
 * so what an assistant recommends and what a merchant sees in their own preview cannot
 * drift apart.
 */
export interface HttpCatalogOptions {
  readonly apiBaseUrl: string;
  readonly buyerAppUrl: string;
  /** Signs a request with SigV4; injected so tests need no AWS. */
  readonly signedFetch: (url: string, init: RequestInit) => Promise<Response>;
}

export class HttpCatalog implements CatalogPort {
  constructor(private readonly options: HttpCatalogOptions) {}

  async search(input: SearchInput): Promise<SearchResponse> {
    const body = {
      ...(input.query ? { query: input.query } : {}),
      ...(input.image_url ? { imageUrl: input.image_url } : {}),
      filters: {
        ...(input.max_price_inr != null ? { maxPriceInr: input.max_price_inr } : {}),
        ...(input.min_price_inr != null ? { minPriceInr: input.min_price_inr } : {}),
        ...(input.category ? { categorySlug: input.category } : {}),
        ...(input.delivery_by_days != null ? { maxDeliveryDays: input.delivery_by_days } : {}),
        ...(input.attributes ? { attributes: input.attributes } : {}),
        ...(input.in_stock_only != null ? { inStockOnly: input.in_stock_only } : {}),
      },
      // Rule 6, enforced here as well as in the schema: a model that ignores the schema
      // default must still not be able to ask for more.
      limit: Math.min(input.limit ?? 5, 5),
      source: 'mcp',
    };

    const response = await this.post('/internal/search', body);

    return {
      results: (response.results ?? []).map((r) => this.toMcpResult(r, input.pincode)),
      ...(response.noResultsReason ? { no_results_reason: response.noResultsReason } : {}),
    };
  }

  async getProduct(input: { product_id: string; pincode?: string }): Promise<unknown> {
    return this.post('/internal/product', {
      productId: input.product_id,
      ...(input.pincode ? { pincode: input.pincode } : {}),
    });
  }

  /**
   * T2.4 — a matrix a model can read across, not a list it has to reconcile.
   *
   * The union of keys with explicit `null` where an item lacks one, because an *omitted*
   * key is ambiguous: a model cannot tell "this shirt has no fabric recorded" from "I
   * forgot to mention the fabric", and it will often guess. A null says the catalogue does
   * not know, which is a fact the model can state.
   */
  async compare(input: { product_ids: string[] }): Promise<ComparisonResponse> {
    const products = await Promise.all(
      input.product_ids.map((id) => this.getProduct({ product_id: id })),
    );

    const items = products.map((p) => {
      const product = p as { id: string; name: string; attributes?: Record<string, unknown> };
      return {
        id: product.id,
        name: product.name,
        attributes: product.attributes ?? {},
      };
    });

    const attributeKeys = [...new Set(items.flatMap((i) => Object.keys(i.attributes)))].sort();

    const normalised = items.map((item) => ({
      ...item,
      attributes: Object.fromEntries(
        attributeKeys.map((key) => [key, item.attributes[key] ?? null]),
      ),
    }));

    /**
     * Only the keys that actually diverge.
     *
     * Without this the model recites the whole table, including the six attributes that are
     * identical across all three — which buries the one difference the buyer is choosing on.
     */
    const differences = attributeKeys.filter((key) => {
      const values = normalised.map((item) => JSON.stringify(item.attributes[key]));
      return new Set(values).size > 1;
    });

    return { items: normalised, attribute_keys: attributeKeys, differences };
  }

  async getPolicies(input: { merchant_id: string }): Promise<unknown> {
    return this.post('/internal/policies', { merchantId: input.merchant_id });
  }

  /**
   * T2.6 — a session and a URL, deliberately not a payment.
   *
   * Creating a Razorpay order here would mean creating it before the buyer has chosen an
   * address, which produces an orphaned payment object for every buyer who changes their
   * mind at the address step — and they change their mind often.
   */
  async createCheckout(input: CheckoutInput): Promise<unknown> {
    /**
     * `/checkout/session`, not `/internal/*`.
     *
     * Checkout is deliberately open at the gateway so a guest can buy without an account,
     * and the single-use handoff token is what authorises the page that follows. Signing
     * this one would work but implies a gate that is not there.
     */
    const session = (await this.post('/checkout/session', {
      productId: input.product_id,
      ...(input.variant_id ? { variantId: input.variant_id } : {}),
      quantity: input.quantity ?? 1,
      ...(input.buyer_email ? { buyerEmail: input.buyer_email } : {}),
    })) as { sessionId?: string; token?: string; expiresAt?: string; summary?: unknown };

    return {
      checkout_url: `${this.options.buyerAppUrl.replace(/\/$/, '')}/s?t=${encodeURIComponent(session.token ?? '')}`,
      session_id: session.sessionId,
      expires_at: session.expiresAt,
      summary: session.summary,
      // Said plainly because the model will relay it, and it is the thing that makes this
      // different from every other shopping integration.
      note: 'The buyer pays this merchant directly. No funds pass through CatalogRail.',
    };
  }

  private toMcpResult(raw: Record<string, unknown>, pincode?: string): McpResult {
    const merchant = (raw.merchant ?? {}) as {
      id?: string;
      name?: string;
      trust?: { score?: number; newMerchant?: boolean; signals?: string[] };
    };

    const asOf = String(raw.priceAsOf ?? new Date().toISOString());

    return {
      id: String(raw.id ?? ''),
      variant_id: (raw.variantId as string) ?? null,
      product_id: String(raw.productId ?? ''),
      name: String(raw.name ?? ''),
      brand: (raw.brand as string) ?? null,
      display_price: (raw.displayPrice as string) ?? null,
      price_paise: raw.pricePaise != null ? String(raw.pricePaise) : null,
      price_as_of: asOf,
      availability: String(raw.availability ?? 'unknown'),
      /**
       * The same timestamp as the price, and separate on purpose.
       *
       * They are read at the same instant today, but a model quoting "in stock" without a
       * time is making a claim about now from data that is not. Keeping the field distinct
       * means a future live-inventory adapter can differ without changing the contract.
       */
      availability_as_of: asOf,
      delivery_estimate: deliveryEstimate(raw.deliveryEstimate as string | undefined, pincode),
      options: (raw.options as Record<string, string>) ?? {},
      why_this_matched: String(raw.whyThisMatched ?? ''),
      merchant: {
        id: String(merchant.id ?? ''),
        name: String(merchant.name ?? ''),
        trust: {
          score: merchant.trust?.score ?? 0,
          new_merchant: merchant.trust?.newMerchant ?? true,
          signals: merchant.trust?.signals ?? [],
        },
      },
      /**
       * The search API returns `images`, an array. This read `raw.imageUrl`, which no
       * response has ever contained, so every result reached the model with no picture and
       * the assistant could only describe what it could not show.
       */
      image_url: firstImage(raw.images),
      /**
       * A page for the buyer to open, which is also what makes the card's image and price
       * checkable against something other than our own word for it.
       */
      product_url: raw.productId
        ? `${this.options.buyerAppUrl.replace(/\/$/, '')}/p/${encodeURIComponent(String(raw.productId))}`
        : null,
    };
  }

  /**
   * The buyer's own token, forwarded — not the MCP server's credentials.
   *
   * The API decides what this buyer may see from the token it receives, so a mistake in the
   * tool layer above cannot widen that. Signing these with the server's own role instead
   * would make every buyer's data reachable by a bug in one `if`.
   */
  async myAddresses(token: string): Promise<unknown> {
    return this.asBuyer('GET', '/buyer/addresses', token);
  }

  async myOrders(token: string, limit = 10): Promise<unknown> {
    const orders = (await this.asBuyer('GET', '/buyer/orders', token)) as {
      orders?: Record<string, unknown>[];
    };
    return { orders: (orders.orders ?? []).slice(0, limit) };
  }

  async orderStatus(token: string, orderNumber: string): Promise<unknown> {
    const result = (await this.asBuyer('GET', '/buyer/orders', token)) as {
      orders?: { orderNumber?: string }[];
    };
    const found = (result.orders ?? []).find((o) => o.orderNumber === orderNumber);
    if (!found) {
      // A quotable sentence, so the model states a fact rather than speculating about
      // where the order went.
      return { found: false, message: `No order ${orderNumber} on this account.` };
    }
    return { found: true, order: found };
  }

  /**
   * Places an order using a saved address, without the buyer leaving the conversation.
   *
   * The address is resolved *here* from the buyer's own saved list rather than accepted as
   * free text from the model — an assistant inventing a delivery address is a parcel sent to
   * a place nobody lives, and it would be invented confidently.
   */
  async placeOrder(token: string, input: PlaceOrderInput): Promise<unknown> {
    const { addresses } = (await this.asBuyer('GET', '/buyer/addresses', token)) as {
      addresses: { id: string; isDefault: boolean; [key: string]: unknown }[];
    };

    const address = input.address_id
      ? addresses.find((a) => a.id === input.address_id)
      : (addresses.find((a) => a.isDefault) ?? addresses[0]);

    if (!address) {
      return {
        ok: false,
        error: 'no_address',
        message:
          'This account has no saved delivery address. Add one at the Conciergent site, then ' +
          'try again.',
      };
    }

    const profile = (await this.asBuyer('GET', '/buyer/me', token)) as { email?: string };
    if (!profile.email) {
      return { ok: false, error: 'no_email', message: 'This account has no email for the receipt.' };
    }

    const session = (await this.post('/checkout/session', {
      productId: input.product_id,
      ...(input.variant_id ? { variantId: input.variant_id } : {}),
      quantity: input.quantity ?? 1,
      buyerEmail: profile.email,
    })) as { sessionId?: string; checkoutUrl?: string; summary?: unknown };

    const paid = (await this.post('/checkout/pay', {
      sessionId: session.sessionId,
      buyerEmail: profile.email,
      buyerPhone: address.recipientPhone,
      shippingAddress: {
        recipientName: address.recipientName,
        recipientPhone: address.recipientPhone,
        line1: address.line1,
        line2: address.line2 ?? '',
        landmark: address.landmark ?? '',
        city: address.city,
        state: address.state,
        pincode: address.pincode,
      },
    })) as { results?: { ok: boolean; orderNumber?: string; error?: string; merchantName?: string }[] };

    const result = paid.results?.[0];
    if (!result?.ok) {
      return { ok: false, error: result?.error ?? 'Order could not be placed.' };
    }

    return {
      ok: true,
      order_number: result.orderNumber,
      merchant: result.merchantName,
      shipping_to: `${address.city}, ${address.state} ${address.pincode}`,
      summary: session.summary,
      /**
       * The payment link, said plainly.
       *
       * The order exists but is not paid: Razorpay's checkout needs the buyer, and a model
       * must not imply money has moved when it has not.
       */
      payment_url: session.checkoutUrl,
      note:
        'The order is reserved but not yet paid. Give the buyer the payment link — they pay ' +
        'the merchant directly, and the stock is held for twenty minutes.',
    };
  }

  private async asBuyer(method: string, path: string, token: string): Promise<unknown> {
    const response = await fetch(`${this.options.apiBaseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    });
    if (!response.ok) {
      throw new AppError('SEARCH_FAILED', `The account service returned ${response.status}.`, {
        details: { path },
      });
    }
    return response.json();
  }

  private async post(path: string, body: unknown): Promise<{
    results?: Record<string, unknown>[];
    noResultsReason?: string;
    [key: string]: unknown;
  }> {
    const response = await this.options.signedFetch(`${this.options.apiBaseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new AppError('SEARCH_FAILED', `The catalogue returned ${response.status}.`, {
        details: { path, body: text.slice(0, 400) },
      });
    }

    return (await response.json()) as Record<string, unknown>;
  }
}

/** Names the destination when we have one, because "3 days" alone invites a wrong guess. */
function deliveryEstimate(estimate: string | undefined, pincode?: string): string | null {
  if (!estimate) return null;
  return pincode ? `${estimate} to ${pincode}` : estimate;
}

/**
 * The first usable image, or null.
 *
 * Empty strings are filtered rather than passed on: a card rendering `<img src="">` re-requests
 * the page it is embedded in, which is a broken image at best and a request loop at worst.
 */
function firstImage(images: unknown): string | null {
  if (!Array.isArray(images)) return null;
  const found = images.find((image) => typeof image === 'string' && image.trim() !== '');
  return typeof found === 'string' ? found : null;
}
