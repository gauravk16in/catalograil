import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  SERVER_DESCRIPTION,
  compareProductsSchema,
  createCheckoutSchema,
  getMerchantPoliciesSchema,
  getMyAddressesSchema,
  getOrderStatusSchema,
  getProductSchema,
  listMyOrdersSchema,
  placeOrderSchema,
  searchProductsSchema,
} from './tools.js';
import { AppError } from '@catalograil/core';
import { PRODUCT_WIDGET_URI, renderWidget } from './widget.js';
import type { CatalogPort } from './port.js';

/**
 * T2.1 — the MCP server.
 *
 * Every tool is a thin wrapper over the same API the dashboards use. That is deliberate:
 * a second query implementation for models would drift from the one buyers see, and the
 * two ranking differently is the kind of bug nobody notices until a merchant asks why the
 * assistant recommends something their own preview does not.
 *
 * The port keeps the SDK wiring separate from the catalogue calls, so the tools are
 * testable without standing up a transport.
 */
/**
 * Supplies the buyer's access token to the authenticated tools.
 *
 * A getter rather than a value, because the server object is built once per invocation while
 * the token belongs to the request — passing it in at construction would be one refactor away
 * from a token outliving the call it came with.
 */
export interface AuthContext {
  token(): string | null;
  requireScope(scope: string): void;
}

/**
 * Per-tool metadata a host reads to decide how to present the call.
 *
 * `openai/outputTemplate` is the one that matters: without it ChatGPT has no template to
 * render and falls back to prose, which is the behaviour this exists to replace. The
 * invoking/invoked strings are what the buyer sees while the search runs — worth writing,
 * because the default is the tool's raw name.
 */
export const TOOL_META: Record<string, Record<string, unknown>> = {
  search_products: {
    'openai/outputTemplate': PRODUCT_WIDGET_URI,
    'openai/toolInvocation/invoking': 'Searching Indian merchants',
    'openai/toolInvocation/invoked': 'Found matching products',
    'openai/widgetAccessible': true,
  },
  get_product: {
    'openai/outputTemplate': PRODUCT_WIDGET_URI,
    'openai/toolInvocation/invoking': 'Fetching the product',
    'openai/toolInvocation/invoked': 'Product loaded',
    'openai/widgetAccessible': true,
  },
};

export function buildServer(catalog: CatalogPort, auth?: AuthContext): McpServer {
  const server = new McpServer(
    { name: 'catalograil', version: '0.1.0' },
    { instructions: SERVER_DESCRIPTION },
  );

  server.tool(
    'search_products',
    'Find products by need, budget, delivery time, attributes or an image. Returns at most ' +
      '5 results, each with live price, stock, a delivery estimate, an `image_url`, a ' +
      '`product_url` and the `variant_id` to buy. When nothing matches, returns a reason sentence you should state as-is ' +
      'rather than explaining away.\n\n' +
      'Results come with a rendered card view. Where that renders, do not restate what is ' +
      'already on screen — add what is not: which one fits what they asked for and why. ' +
      'Where it does not, give each product its image as a markdown image, its name linked ' +
      'to `product_url`, then price, stock and delivery — never a bare paragraph of prose. ' +
      'To buy, call create_checkout for a guest link, or place_order if they have connected ' +
      'their account.',
    searchProductsSchema,
    async (input) => {
      const result = await catalog.search(input);
      return rendered(result as unknown as Record<string, unknown>);
    },
  );

  server.tool(
    'get_product',
    'Full detail for one product: description, every variant with its own price and stock, ' +
      'images, merchant profile and policy summaries. Use after search_products when the ' +
      'buyer asks about a specific item, sizes, or availability.',
    getProductSchema,
    async (input) => rendered((await catalog.getProduct(input)) as Record<string, unknown>),
  );

  server.tool(
    'compare_products',
    'Compare 2–4 products on a normalised attribute matrix. Returns every attribute key any ' +
      'of them has, with explicit nulls where one lacks it, plus a `differences` list naming ' +
      'the keys that actually diverge — lead with those rather than reciting the table.',
    compareProductsSchema,
    async (input) => json(await catalog.compare(input)),
  );

  server.tool(
    'get_merchant_policies',
    'A merchant’s refund, terms and fulfillment policies: a short summary, the merchant’s ' +
      'own full text, and when it was last checked. Answer every policy question from this ' +
      'tool alone. Quote or paraphrase the `text` for anything the `summary` does not cover — ' +
      'and if neither says, say that it does not, rather than reasoning about what is likely.',
    getMerchantPoliciesSchema,
    async (input) => json(await catalog.getPolicies(input)),
  );

  server.tool(
    'create_checkout',
    'Start a purchase. Returns a URL that opens a page where the buyer picks an address and ' +
      'pays the merchant directly. This does not charge anything and does not create a ' +
      'payment yet — give the buyer the link and let them complete it.',
    createCheckoutSchema,
    async (input) => json(await catalog.createCheckout(input)),
  );

  /**
   * The authenticated tools (T2.7).
   *
   * Registered unconditionally so an assistant that has *not* connected still sees they
   * exist — a tool that appears only after authentication cannot prompt anyone to
   * authenticate, and the buyer is left wondering why their assistant cannot see their
   * orders.
   */
  server.tool(
    'get_my_addresses',
    'The buyer’s saved delivery addresses. Use before place_order so you can tell them where ' +
      'it is going. Requires them to have connected their Conciergent account.',
    getMyAddressesSchema,
    async () => {
      const token = requireToken(auth, 'catalograil/addresses.read');
      return json(await catalog.myAddresses(token));
    },
  );

  server.tool(
    'list_my_orders',
    'The buyer’s recent orders with their current status. Requires a connected account.',
    listMyOrdersSchema,
    async (input) => {
      const token = requireToken(auth, 'catalograil/orders.read');
      return json(await catalog.myOrders(token, input.limit));
    },
  );

  server.tool(
    'get_order_status',
    'Where one order has got to, by its order number. Requires a connected account.',
    getOrderStatusSchema,
    async (input) => {
      const token = requireToken(auth, 'catalograil/orders.read');
      return json(await catalog.orderStatus(token, input.order_number));
    },
  );

  server.tool(
    'place_order',
    'Place an order using the buyer’s saved address, without them leaving this conversation. ' +
      'Confirm the product, the variant, the quantity and the delivery address with them ' +
      'before calling this — it reserves stock and creates a real order. Returns a payment ' +
      'link they must open to pay the merchant; nothing is charged until they do.',
    placeOrderSchema,
    async (input) => {
      const token = requireToken(auth, 'catalograil/orders.write');
      return json(await catalog.placeOrder(token, input));
    },
  );

  return server;
}

function requireToken(auth: AuthContext | undefined, scope: string): string {
  const token = auth?.token();
  if (!token) {
    // Thrown rather than returned, so the handler can answer with the structured
    // "connect your account" payload that tells the assistant where to send the buyer.
    throw new AppError('UNAUTHENTICATED', 'This needs a connected Conciergent account.');
  }
  auth!.requireScope(scope);
  return token;
}

/**
 * Tool results go back as JSON in a text block.
 *
 * A model reads these, and a compact structure it can quote from beats prose it has to
 * re-interpret — the hallucination audit (T2.27) is largely a test of whether every fact
 * the model states was present here to be quoted.
 */
function json(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

/**
 * A result that a client can *render* as well as read.
 *
 * Three representations of the same facts, because three kinds of client will read this and
 * none of them can be relied on to support the others:
 *
 * - `content[0]`, the JSON text block, is what the model quotes from. It is never dropped:
 *   an assistant that cannot draw the widget must still be able to answer the question.
 * - `structuredContent` is what ChatGPT hands to the template on `window.openai.toolOutput`.
 * - `content[1]`, the embedded `ui://` resource, is the whole widget with the data already
 *   inside it, for MCP-UI clients that render a resource block inline.
 */
function rendered(payload: Record<string, unknown>) {
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify(payload, null, 2) },
      {
        type: 'resource' as const,
        resource: {
          uri: PRODUCT_WIDGET_URI,
          mimeType: 'text/html',
          text: renderWidget(payload),
        },
      },
    ],
    structuredContent: payload,
    _meta: { 'openai/outputTemplate': PRODUCT_WIDGET_URI },
  };
}
