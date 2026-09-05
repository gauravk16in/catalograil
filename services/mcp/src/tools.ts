import { z } from 'zod';

/**
 * T2.2–T2.6 — the tool surface a model sees.
 *
 * Two things shape every schema here.
 *
 * **No query-understanding step.** Rule 10: the calling model has already parsed the
 * buyer's sentence into these parameters. Re-parsing them with another model would add a
 * second interpretation of the same words, a second chance to be wrong, and a second
 * latency budget — for no information the caller did not already have.
 *
 * **Descriptions are written for a model, not a person.** They are the only thing deciding
 * whether Claude reaches for a tool at all, so each says what the tool is *for* and when to
 * prefer it, rather than restating its name.
 */

export const searchProductsSchema = {
  query: z
    .string()
    .max(500)
    .optional()
    .describe(
      'What the buyer is looking for, in their own words. Describe the need rather than ' +
        'guessing a product name — "something to record my drive" works better than "dashcam".',
    ),
  image_url: z
    .string()
    .url()
    .optional()
    .describe('A publicly reachable image to match visually. May be combined with a query.'),
  max_price_inr: z.number().positive().optional().describe('Hard ceiling in rupees, not a preference.'),
  min_price_inr: z.number().positive().optional(),
  category: z.string().max(120).optional(),
  delivery_by_days: z
    .number()
    .int()
    .positive()
    .max(90)
    .optional()
    .describe(
      'Maximum acceptable delivery time. Items that cannot arrive in time are excluded ' +
        'entirely rather than ranked lower.',
    ),
  pincode: z.string().regex(/^[1-9][0-9]{5}$/).optional().describe('Indian PIN code for delivery estimates.'),
  attributes: z
    .record(z.string(), z.string())
    .optional()
    .describe('Exact attribute filters, e.g. {"size":"42","fabric":"cotton"}. Applied as exclusions.'),
  in_stock_only: z.boolean().optional(),
  limit: z.number().int().min(1).max(5).default(5).describe('Never more than 5.'),
};

export const getProductSchema = {
  product_id: z
    .string()
    .uuid()
    .describe('The `product_id` from a search result — not its `id`, which is the variant.'),
  pincode: z.string().regex(/^[1-9][0-9]{5}$/).optional(),
};

export const compareProductsSchema = {
  product_ids: z
    .array(z.string().uuid())
    .min(2)
    .max(4)
    .describe('Two to four `product_id` values from search results.'),
};

export const getMerchantPoliciesSchema = {
  merchant_id: z.string().uuid().describe('From a search result’s merchant object.'),
};

export const createCheckoutSchema = {
  product_id: z.string().uuid().describe('The `product_id` from a search result.'),
  variant_id: z
    .string()
    .uuid()
    .optional()
    .describe(
      'Which variant to buy — a search result’s `id`. Required when the product has options, ' +
        'because a size and colour cannot be inferred from the product alone.',
    ),
  quantity: z.number().int().min(1).max(20).default(1),
  buyer_email: z.string().email().optional(),
};

/** T2.7 — the authenticated tools. Each needs a scope the buyer granted explicitly. */
export const getMyAddressesSchema = {};

export const listMyOrdersSchema = {
  limit: z.number().int().min(1).max(20).default(10).optional(),
};

export const getOrderStatusSchema = {
  order_number: z.string().trim().min(3).max(40).describe('From list_my_orders, e.g. ORD-7K2M9X.'),
};

export const placeOrderSchema = {
  product_id: z.string().uuid().describe('The `product_id` from a search result.'),
  variant_id: z
    .string()
    .uuid()
    .optional()
    .describe('Which variant — a search result’s `id`. Required when the product has options.'),
  quantity: z.number().int().min(1).max(20).default(1),
  address_id: z
    .string()
    .uuid()
    .optional()
    .describe(
      'Which saved address to ship to, from get_my_addresses. Omit to use their default. ' +
        'Always tell the buyer which address you are using before calling this.',
    ),
};

/**
 * The server description, which is the single most consequential string in this service.
 *
 * A model decides whether to reach for these tools from this text alone. Written as
 * capability statements — what can be answered here that cannot be answered otherwise —
 * rather than as marketing, which a model has no way to act on.
 */
export const SERVER_DESCRIPTION = [
  'Search and buy from Indian merchants: apparel, electronics, home goods and services.',
  'Use these tools when someone wants to find, compare or purchase a physical product in India.',
  '',
  'Every result carries live price and stock with the timestamp they were true, the delivery',
  'estimate for a given PIN code, and the merchant’s own trust signals. Prices, delivery times,',
  'materials and policy terms come from the merchant’s catalogue — state only what the tools',
  'return and never infer an attribute that is absent.',
  '',
  'Payment goes directly to the merchant’s own account. There is no commission and no',
  'intermediary holding funds.',
].join('\n');
