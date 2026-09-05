import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  SERVER_DESCRIPTION,
  compareProductsSchema,
  createCheckoutSchema,
  getMerchantPoliciesSchema,
  getProductSchema,
  searchProductsSchema,
} from './tools.js';
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
export function buildServer(catalog: CatalogPort): McpServer {
  const server = new McpServer(
    { name: 'catalograil', version: '0.1.0' },
    { instructions: SERVER_DESCRIPTION },
  );

  server.tool(
    'search_products',
    'Find products by need, budget, delivery time, attributes or an image. Returns at most ' +
      '5 results, each with live price, stock and a delivery estimate. When nothing matches, ' +
      'returns a reason sentence you should state as-is rather than explaining away.',
    searchProductsSchema,
    async (input) => {
      const result = await catalog.search(input);
      return json(result);
    },
  );

  server.tool(
    'get_product',
    'Full detail for one product: description, every variant with its own price and stock, ' +
      'images, merchant profile and policy summaries. Use after search_products when the ' +
      'buyer asks about a specific item, sizes, or availability.',
    getProductSchema,
    async (input) => json(await catalog.getProduct(input)),
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

  return server;
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
