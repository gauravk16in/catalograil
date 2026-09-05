import { z } from 'zod';

/**
 * Models do not send JSON types. They send strings.
 *
 * Observed from a real Claude tool call: `limit` arrived as `"5"`, `in_stock_only` as
 * `"true"`, and every optional the model chose not to use arrived as `""` rather than being
 * omitted. A strict schema rejects all of that, and the buyer sees "the connector is
 * broken" — which is what happened.
 *
 * The JSON Schema advertises the right types and models still do this, so tolerating it is
 * not a workaround to be removed later; it is what talking to a model requires. The
 * coercion is narrow and total: an empty string means "not given", and a numeric or boolean
 * string means what it looks like.
 */
const blankToUndefined = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? undefined : value);

/** `"5"` → 5, `""` → undefined, `5` → 5. Anything else is left for Zod to reject. */
const toNumber = (value: unknown) => {
  const v = blankToUndefined(value);
  if (typeof v === 'string') {
    const parsed = Number(v);
    return Number.isFinite(parsed) ? parsed : v;
  }
  return v;
};

/** `"true"` / `"false"` → boolean, `""` → undefined. Anything else is left for Zod. */
const toBoolean = (value: unknown) => {
  const v = blankToUndefined(value);
  if (typeof v === 'string') {
    if (v.toLowerCase() === 'true') return true;
    if (v.toLowerCase() === 'false') return false;
  }
  return v;
};

/**
 * Coercion has to run *inside* optionality, and the coerced value has to stay acceptable
 * afterwards. `""` is not `undefined` until the preprocessor has run, so `optional()` on the
 * outside never short-circuits it — the preprocessor turns it into `undefined` and whatever
 * follows must then tolerate that. Hence undefined is admissible at all three layers of an
 * optional field: the preprocess target, the pipe target, and the field itself. The last one
 * is what makes an entirely absent key legal.
 */
const reqString = <T extends z.ZodType<string, string>>(inner: T) => z.preprocess(blankToUndefined, z.string()).pipe(inner);
const optString = <T extends z.ZodType<string, string>>(inner: T) =>
  z
    .preprocess(blankToUndefined, z.string().optional())
    .pipe(inner.optional())
    .optional();
const optNumber = <T extends z.ZodType<number, number>>(inner: T) =>
  z
    .preprocess(toNumber, z.number().optional())
    .pipe(inner.optional())
    .optional();
const optBoolean = () =>
  z
    .preprocess(toBoolean, z.boolean().optional())
    .pipe(z.boolean().optional())
    .optional();

/** An optional number that falls back to `fallback` whether it was blank or absent. */
const optNumberWithDefault = <T extends z.ZodType<number, number>>(inner: T, fallback: number) =>
  optNumber(inner).transform((v) => v ?? fallback);

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
  query: optString(z.string().max(500)).describe(
    'What the buyer is looking for, in their own words. Describe the need rather than ' +
      'guessing a product name — "something to record my drive" works better than "dashcam".',
  ),
  image_url: optString(z.string().url()).describe(
    'A publicly reachable image to match visually. May be combined with a query.',
  ),
  max_price_inr: optNumber(z.number().positive()).describe('Hard ceiling in rupees, not a preference.'),
  min_price_inr: optNumber(z.number().positive()),
  category: optString(z.string().max(120)),
  delivery_by_days: optNumber(z.number().int().positive().max(90)).describe(
    'Maximum acceptable delivery time. Items that cannot arrive in time are excluded ' +
      'entirely rather than ranked lower.',
  ),
  pincode: optString(z.string().regex(/^[1-9][0-9]{5}$/)).describe('Indian PIN code for delivery estimates.'),
  attributes: z
    .record(z.string(), z.string())
    .optional()
    .describe('Exact attribute filters, e.g. {"size":"42","fabric":"cotton"}. Applied as exclusions.'),
  in_stock_only: optBoolean(),
  limit: optNumberWithDefault(z.number().int().min(1).max(5), 5).describe('Never more than 5.'),
};

export const getProductSchema = {
  product_id: reqString(z.string().uuid()).describe(
    'The `product_id` from a search result — not its `id`, which identifies the result.',
  ),
  pincode: optString(z.string().regex(/^[1-9][0-9]{5}$/)),
};

export const compareProductsSchema = {
  product_ids: z
    .array(z.string().uuid())
    .min(2)
    .max(4)
    .describe('Two to four `product_id` values from search results.'),
};

export const getMerchantPoliciesSchema = {
  merchant_id: reqString(z.string().uuid()).describe('From a search result’s merchant object.'),
};

export const createCheckoutSchema = {
  product_id: reqString(z.string().uuid()).describe('The `product_id` from a search result.'),
  variant_id: optString(z.string().uuid()).describe(
    'Which variant to buy — a search result’s `variant_id`, never its `id`. Required when ' +
      'the product has options, because a size and colour cannot be inferred from the ' +
      'product alone. Omit it when `variant_id` is null.',
  ),
  quantity: optNumberWithDefault(z.number().int().min(1).max(20), 1),
  buyer_email: optString(z.string().email()),
};

/** T2.7 — the authenticated tools. Each needs a scope the buyer granted explicitly. */
export const getMyAddressesSchema = {};

export const listMyOrdersSchema = {
  limit: optNumberWithDefault(z.number().int().min(1).max(20), 10),
};

export const getOrderStatusSchema = {
  order_number: reqString(z.string().trim().min(3).max(40)).describe('From list_my_orders, e.g. ORD-7K2M9X.'),
};

export const placeOrderSchema = {
  product_id: reqString(z.string().uuid()).describe('The `product_id` from a search result.'),
  variant_id: optString(z.string().uuid()).describe(
    'Which variant — a search result’s `variant_id`, never its `id`. Required when the ' +
      'product has options; omit it when `variant_id` is null.',
  ),
  quantity: optNumberWithDefault(z.number().int().min(1).max(20), 1),
  address_id: optString(z.string().uuid()).describe(
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
