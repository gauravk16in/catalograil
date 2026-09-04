# PHASE 2 — MCP Server, Image Search, Payments, Split-Screen Surface

**Objective:** A Claude or ChatGPT user finds a product, compares options, and completes a purchase paid directly to the merchant. Merchant is notified.

**Prerequisites:** Phase 1 exit checklist fully green.

**Exit criterion:** 12 test-matrix scenarios pass on both ChatGPT and Claude. 10 test purchases across 5 product types complete end to end with funds landing in the merchant's test account. Zero hallucinated attributes across a 50-query audit.

---

## Block A — MCP server

### T2.1 MCP server scaffold
`/services/mcp`

Streamable HTTP transport on Lambda behind a Function URL. Use the official MCP TypeScript SDK. Provisioned concurrency of 2 on `prod` — cold starts inside a tool call are unacceptable.

Server metadata: name, version, description written for model consumption. The description determines whether the model reaches for your tools at all — write it as capability statements, not marketing.

**Acceptance:** `npx @modelcontextprotocol/inspector` connects and lists tools.

### T2.2 Tool: `search_products`
```
Input:
  query            string, optional if image_url given
  image_url        string, optional
  max_price_inr    number, optional
  min_price_inr    number, optional
  category         string, optional
  delivery_by_days number, optional
  pincode          string, optional
  attributes       object, optional   e.g. {"size":"42","fabric":"cotton"}
  limit            number, default 5, max 5
```

Wraps `/internal/search`. **Do not add an LLM query-understanding step** — the calling model already parsed intent into these params.

Per-result response shape:
```json
{
  "id": "...",
  "name": "...",
  "brand": "...",
  "display_price": "₹2,499",
  "price_paise": 249900,
  "price_as_of": "2026-09-04T14:22:01Z",
  "availability": "in_stock",
  "availability_as_of": "...",
  "delivery_estimate": "Arrives in 3 days to 560001",
  "options": {"size": "42", "colour": "lilac"},
  "why_this_matched": "Cotton, size 42, ships in 3 days",
  "merchant": {
    "name": "...",
    "trust": {
      "score": 0.87,
      "new_merchant": false,
      "signals": ["GSTIN verified", "312 orders fulfilled",
                  "94% delivered on time", "4.6★ from 212 buyers"]
    }
  },
  "image_url": "...",
  "product_url": "https://app.../s/{token}?p={id}"
}
```

Empty results return `{"results": [], "no_results_reason": "Nothing under ₹2,000 delivers to 560001 within 4 days. The closest match is ₹2,499 arriving in 3 days."}`

**Acceptance:** Max 5 results always. Every result carries both `_as_of` fields. Empty query returns a quotable reason sentence.

### T2.3 Tool: `get_product`
Full detail: description, all variants with per-variant price and stock, all images, merchant profile, trust components, policy summaries, delivery estimate for a given pincode.

**Acceptance:** A 24-variant product returns all variants with correct availability.

### T2.4 Tool: `compare_products`
Input: 2–4 product or variant IDs. Returns a normalised attribute matrix.

Build the matrix by taking the union of attribute keys across the inputs, and returning `null` — not omission — where an item lacks a key. Add a `differences` array naming the keys where values actually diverge, so the model leads with what matters instead of reciting the whole table.

**Acceptance:** Comparing 3 dashcams returns aligned rows with explicit nulls and a differences list.

### T2.5 Tool: `get_merchant_policies`
Returns the Claude-extracted summaries plus the source URLs. Never generate policy text — return only what the policy checker extracted, with `last_checked_at`.

**Acceptance:** "What's their return policy?" is answerable from this tool alone with a citable URL.

### T2.6 Tool: `create_checkout`
```
Input: product_id, variant_id?, quantity, buyer_email?
Output: { checkout_url, session_id, expires_at, summary }
```

Does **not** create a Razorpay order. It creates a session (T2.12) and returns the split-screen URL. Payment happens on our page after address selection. This matters: creating a payment object before the buyer picks an address produces orphaned orders.

**Acceptance:** Returns a working URL that opens the split-screen with the right product preloaded.

### T2.7 Authenticated tools
`get_my_addresses`, `get_order_status`, `list_my_orders`

OAuth 2.1 + PKCE. Implement the full discovery metadata (`/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`) so Claude and ChatGPT can initiate the flow automatically. Scopes: `addresses:read`, `orders:read`, `orders:write`.

Unauthenticated calls to these tools return a structured error telling the model to prompt the user to connect — not a generic 401.

**Acceptance:** Adding the MCP URL in Claude triggers the auth flow, and `get_my_addresses` returns the buyer's saved addresses afterwards.

### T2.8 Rate limiting and abuse control
Per-IP and per-session token buckets in DynamoDB `RateLimits`. 30 searches/min, 10 checkouts/hour. Return `429` with `retry_after`.

**Acceptance:** 31st search in a minute is throttled with a clear message.

---

## Block B — Image search

### T2.9 Image ingestion in search path
When `image_url` is present:
1. Fetch with a 3s timeout, max 10MB, allowed types jpeg/png/webp
2. Resize to the model's expected bounds before embedding
3. Embed via the multimodal model → `q_visual`
4. Query `v_visual` with the same filters, fuse with any text query at weight 1.0 for visual, 0.6 for text

Cache image embeddings by SHA of the image bytes for 24h — buyers re-ask about the same photo constantly.

**Acceptance:** Uploading a photo of a striped blue shirt with `attributes:{size:"42", fabric:"cotton"}` returns cotton size-42 shirts, visually similar first.

### T2.10 Combined visual + attribute + SLA query
This is example 2 end to end. Verify the SQL applies the variant attribute filter **before** the vector search, not after — otherwise the top-100 ANN candidates get filtered down to nothing.

**Acceptance:** `EXPLAIN ANALYZE` shows the attribute filter in the pre-filter CTE. Result set is non-empty for a query that has valid matches beyond ANN position 100.

---

## Block C — Trust score

### T2.11 Trust computation
`/packages/trust` + `/services/workers/metrics`

Nightly EventBridge job at 03:00 IST recomputes `merchant_metrics` for all merchants.

```
verificationScore = weighted:
    gstin_verified            0.30
    razorpay_account_active   0.25
    all 3 policy URLs valid   0.25
    business_age_months >= 6  0.20

trustScore =
    0.25·verificationScore
  + 0.25·fulfillmentRate        orders_fulfilled / orders_accepted
  + 0.20·onTimeRate
  + 0.15·bayesianRating         (C·m + Σr) / (C + n), C=10, m=platform mean
  + 0.10·responsiveness         1 - min(avg_ack_minutes/360, 1)
  + 0.05·(1 - disputeRate)
```

Cold start: if `orders_total < 10`, set `is_new_merchant = true` and cap `trust_score` at `min(verificationScore, 0.60)`.

Write the result back to `merchant_metrics` and propagate to `searchable_units.trust_score`.

**Acceptance:** A seeded merchant with known metrics produces the hand-calculated score. A 3-order merchant with perfect ratings scores below a 400-order merchant at 4.6★.

### T2.12 Trust signals renderer
Convert numeric components into the human-readable `signals[]` array. Only include signals that are true and meaningful — never "0 orders fulfilled". For new merchants, include `"New on the platform"` explicitly rather than hiding it.

**Acceptance:** A brand new merchant's signals array reads honestly and does not imply a track record.

---

## Block D — Payments, direct to merchant

### T2.13 Session and cart
DynamoDB `Sessions`. Structure:
```
{ sessionId, buyerId?, createdAt, expiresAt,
  handoffContext: { conversationSummary, originalQuery, shortlist[] },
  cart: [ { productId, variantId, quantity, merchantId, priceSnapshot } ],
  selectedAddressId?, guestContact? }
```

Cart may span merchants. Session TTL 24 hours.

**Acceptance:** A session created by `create_checkout` survives page reload and carries the handoff context.

### T2.14 Handoff token
Signed JWT, 15-minute expiry, encoding `sessionId` and a signature. Short and URL-safe. Exchanged once at page load for a session cookie — the token in the URL must not remain a valid credential after first use.

**Acceptance:** Reusing a consumed token is rejected. An expired token shows a friendly "start again" page, not an error.

### T2.15 Razorpay order creation on the merchant's account
`/packages/razorpay/src/orders.ts`

```
For each merchant in the cart:
  1. Load and decrypt that merchant's access token
  2. If expired or refresh failed → block, return a clear error naming the merchant
  3. Re-validate: product active, merchant active, stock sufficient, price unchanged
  4. Reserve stock: conditional UPDATE ... WHERE stock >= qty RETURNING
  5. POST /v1/orders with Authorization: Bearer <merchant_token>
  6. Create our `orders` row with policy_snapshot
  7. Return the Razorpay order for the checkout widget
```

Reservation is released by a sweeper if payment is not captured within 20 minutes.

**Acceptance:** Order appears in the merchant's own Razorpay test dashboard, not ours. Three concurrent buyers against one unit of stock produce exactly one successful reservation.

### T2.16 Webhook handling
`POST /webhooks/razorpay/{merchantId}`

Each merchant registers our URL on their own account during onboarding — automate this via their token at activation.

1. Verify the HMAC signature using **that merchant's** webhook secret. Reject unsigned.
2. Idempotency: conditional put of `razorpay_event_id` into `IdempotencyKeys`. Already present → return 200 and stop.
3. `payment.captured` → order `paid`, commit stock reservation, write `order_events`, enqueue notification
4. `payment.failed` → release reservation, order `failed`
5. `refund.processed` → order `refunded`, write event

**Acceptance:** The same webhook delivered 5 times produces exactly one order transition. An unsigned request is rejected with 400.

### T2.17 Stock reservation sweeper
EventBridge every 5 minutes. Releases reservations older than 20 minutes with no captured payment.

**Acceptance:** An abandoned checkout returns stock within 25 minutes.

### T2.18 Merchant notification
`/services/workers/notification`

SES email immediately on `paid`: order number, items, buyer contact, shipping address, an acknowledge link. Optional WhatsApp via Gupshup if the merchant has opted in.

Escalation: unacknowledged after 6h → reminder. After 24h → flag, and the miss counts against `responsiveness`.

**Acceptance:** Email arrives within 10 seconds of capture. Escalation fires correctly against a seeded stale order.

---

## Block E — Split-screen surface

### T2.19 Layout and routing
`/apps/buyer`, route `/s/[token]`

Desktop: product pane left (60%), chat pane right (40%). Mobile: product pane collapses to a sticky summary bar, chat full-screen, expandable.

Product pane: image gallery, name, price with `price_as_of`, variant selector, delivery estimate for the selected address, trust signals, policy links, primary CTA.

**Acceptance:** Renders correctly at 375px and 1440px. No layout shift on variant change.

### T2.20 Chat pane
Claude via the Anthropic API, streaming. System prompt seeded with the handoff context — the conversation summary, the original query, and the shortlist that produced this result. The buyer must never have to re-explain what they wanted.

Tools available to this assistant: the same search/compare/policy tools, plus `select_variant`, `add_to_cart`, `remove_from_cart`, `set_address`.

When the assistant calls `select_variant` or navigates to a different product, the left pane updates. This bidirectional binding is the whole point of the surface.

**Acceptance:** A buyer who arrives from Claude asks "do you have this in blue?" and the assistant answers using the context, then updates the left pane on selection.

### T2.21 Address selection and checkout
- Logged-in buyer: address list with labels, one-tap select
- Guest: inline address form, no account required
- Cart spanning merchants: grouped by merchant with separate delivery estimates
- Razorpay Checkout widget per merchant, sequenced

**Partial failure handling:** if merchant A succeeds and B fails, the buyer keeps A's order and gets a clear retry for B alone. Never roll back a successful payment.

**Acceptance:** A two-merchant cart where the second payment fails leaves one valid order and a retriable second.

### T2.22 Trust and policy display
Show, unmissably, on the payment step: *"You're paying {Merchant} directly. We never hold your money."* Alongside it, the merchant's refund window and dispatch SLA from the extracted summaries, with links.

**Acceptance:** Present on every checkout, desktop and mobile.

---

## Block F — Buyer accounts

### T2.23 Signup and login
Phone OTP primary (India), email magic link fallback. Rate-limited OTP, 6 digits, 10-minute expiry, max 3 attempts.

### T2.24 Addresses
CRUD with custom labels. Validate pincode against a serviceability table; warn at save time if no active merchant can deliver there. Set default.

**Acceptance:** Buyer saves "Office" and "Mom's place", selects one at checkout in one tap.

### T2.25 Order history and guest linking
Order list with status and timeline. On signup, link any prior guest orders matching the verified email or phone.

**Acceptance:** A guest who places an order and signs up the next day sees that order in their history.

---

## Block G — Testing and distribution

### T2.26 Test matrix
Run every row in **both** ChatGPT Developer Mode and Claude custom connector. Behaviour differs between them; do not assume parity.

| # | Scenario | Validates |
|---|---|---|
| 1 | "gift for my boss under ₹3000" | budget filter + semantic match |
| 2 | "something for a housewarming, need it by Saturday" | delivery constraint |
| 3 | Upload shirt image, "size 42, cotton or linen, under 4 days" | multimodal + attribute + SLA |
| 4 | "compare the top 3" | tool selection for compare |
| 5 | "cheapest that still ships fast" | multi-constraint tradeoff |
| 6 | "what's their return policy?" | policy tool, no invention |
| 7 | Query with genuinely no matches | `no_results_reason`, no hallucination |
| 8 | Out-of-stock item requested | exclusion correctness |
| 9 | Suspended merchant's product | never surfaces |
| 10 | Merchant with expired token | excluded from search |
| 11 | Payment abandoned | stock released |
| 12 | Duplicate webhook ×5 | exactly one order |

### T2.27 Hallucination audit
Run 50 queries. For every product attribute the model states in its reply — price, delivery time, material, dimensions, policy terms — diff against the database.

**Any invented attribute is a P0.** It almost always means a field is missing from the tool response, so fix the response shape rather than the prompt.

**Acceptance:** Zero invented attributes across 50 queries. Record the audit sheet.

### T2.28 Load and latency
- MCP tool call p95 under 1.5s including cold-start protection
- Search p95 under 200ms
- 100 concurrent sessions on the split-screen surface without Aurora connection exhaustion (verify RDS Proxy is doing its job)

### T2.29 Directory submission
Prepare and submit to both:
- **ChatGPT:** MCP connectivity details, testing instructions with a working test account, directory metadata, country availability (India), privacy policy URL
- **Claude:** connector directory submission

Assume 2–6 weeks of review. **Start Phase 3 the day you submit.** Do not idle.

---

## Phase 2 exit checklist

- [ ] All 12 test-matrix rows pass on ChatGPT and on Claude
- [ ] Hallucination audit: 0 invented attributes across 50 queries
- [ ] 10 test purchases across 5 product types complete end to end
- [ ] Funds land in the merchant's Razorpay test account, not ours
- [ ] Duplicate webhooks produce exactly one order
- [ ] Concurrent stock race resolves to exactly one winner
- [ ] Expired merchant token excludes their catalog from search
- [ ] Image search returns correct variant-level results
- [ ] Trust signals read honestly for a brand new merchant
- [ ] Split-screen carries handoff context; buyer never re-explains
- [ ] Two-merchant cart handles partial payment failure without data loss
- [ ] "Paying merchant directly" notice present on every checkout
- [ ] MCP p95 under 1.5s
- [ ] Both directory submissions filed
