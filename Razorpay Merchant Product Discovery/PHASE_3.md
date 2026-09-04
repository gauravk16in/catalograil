# PHASE 3 — Live Inventory, Bookings, Quotations, Fulfillment

**Objective:** Unlock the three remaining archetypes. A hotel night, a doctor's appointment, and a custom quotation all complete end to end.

**Prerequisites:** Phase 2 exit checklist green. Directory submissions filed.

**Exit criterion:** One booking, one live-priced purchase, and one quotation-to-payment flow complete in test mode. Fulfillment score computes correctly from real order data.

---

## Block A — The adapter contract

### T3.1 Publish the adapter specification
`/packages/adapters/CONTRACT.md` + OpenAPI spec

This is a public document merchants implement against. Version it (`v1`) and never break it.

**`POST /quote`** — for `LIVE_PRICED`
```
Request:  { offering_ref, params: {...}, quantity, currency: "INR",
            request_id, requested_at }
Response: { available: bool, options: [ { option_ref, price_paise,
            display_label, valid_until, metadata{} } ],
            unavailable_reason?: string }
```

**`GET /slots`** — for `BOOKABLE`
```
Query:    offering_ref, from (ISO date), to, quantity, location?
Response: { slots: [ { slot_ref, starts_at, ends_at, capacity_remaining,
            price_paise, location{}, metadata{} } ] }
```

**`POST /hold`**
```
Request:  { slot_ref, quantity, hold_duration_seconds, request_id }
Response: { hold_ref, expires_at, price_paise }   // price is now locked
```

**`POST /confirm`**
```
Request:  { hold_ref, payment_reference, buyer{}, request_id }
Response: { booking_ref, status, confirmation_details{} }
```

**`POST /release`** — release a hold

**`POST /rfq`** — for `QUOTE`
```
Request:  { offering_ref, fields{}, buyer_contact{}, request_id }
Response: { rfq_ref, expected_response_hours }
```
Merchant later calls back to our `POST /adapters/quotations/{rfq_ref}/respond`.

**`GET /health`** — returns 200 with `{status, version}`

**Contract rules, stated in the doc:**
- Every request carries `request_id`; adapters must be idempotent on it
- Respond within 2000ms or we drop you from that query
- Prices in paise, integers, always
- Never return an option you cannot honour for `valid_until`

**Acceptance:** Spec published, OpenAPI validates, a mock server generated from it passes the conformance suite (T3.3).

### T3.2 Reference implementations
Ship working adapters merchants can fork:
- `/packages/adapters/reference/node-express`
- `/packages/adapters/reference/python-fastapi`
- `/packages/adapters/reference/sheets` — a hosted adapter backed by a Google Sheet, for merchants with no engineering team. This one matters more than the other two; most Indian SMB merchants will not write an adapter.

**Acceptance:** A merchant with a Google Sheet of slots can go live without writing code.

### T3.3 Conformance test suite
`pnpm adapter:verify --url https://merchant.example/adapter`

Runs the full contract: schema validation, idempotency (same `request_id` twice), timeout behaviour, error shapes, hold-then-release, hold expiry. Outputs a pass/fail report.

Merchants must pass this before their live capability is enabled. Expose it as a button in the dashboard.

**Acceptance:** A deliberately broken adapter fails with specific, actionable errors.

---

## Block B — Adapter runtime

### T3.4 Adapter client with circuit breaker
`/packages/adapters/src/client.ts`

- 2000ms hard timeout, no retries inside the request path
- Circuit breaker: 3 consecutive failures → open for 5 minutes → half-open probe
- Every call logged with latency and outcome to `SearchLogs`
- Credentials from Secrets Manager, never in the `adapters` table

**Acceptance:** A merchant endpoint returning 500 three times opens the circuit and stops receiving traffic for 5 minutes without affecting other merchants.

### T3.5 Health monitoring
EventBridge every 5 minutes, `GET /health` on every enabled adapter. Three consecutive failures → disable the capability, email the merchant, remove their live offerings from search.

**Acceptance:** A merchant who takes their adapter offline has their live offerings removed within 15 minutes and is notified.

### T3.6 Parallel fan-out in the search path
When the reranked top 20 contains `LIVE_PRICED` or `BOOKABLE` units:

1. Group by merchant, dedupe adapter calls
2. Check `AdapterCache` (60s TTL) first
3. Fan out remaining calls in parallel with `Promise.allSettled` and a 2000ms budget for the whole batch
4. Drop timed-out adapters from results entirely — **never show a stale price as current**
5. If a cached price exists but is stale, show it with an explicit `"price_as_of"` and an `"estimated": true` flag
6. Re-rank with real prices

**Acceptance:** A query touching 5 live merchants, one of which hangs, returns in under 2.2s with 4 resolved results and the hanging merchant absent.

### T3.7 Adapter cache warming
For high-traffic offerings, a background worker pre-fetches quotes on a schedule so the interactive path hits cache. Track query frequency from `SearchLogs` and warm the top 200 offering+param combinations.

**Acceptance:** Warmed offerings resolve from cache with sub-50ms added latency.

---

## Block C — Bookable flow

### T3.8 Slot ingestion and sync
Two modes:
- **Push:** merchant posts slots to `POST /merchant/slots/bulk`, stored in `slots`
- **Pull:** we call `GET /slots` on demand, cached 60s

Push is better for high-volume (cinemas). Pull is better for low-volume, frequently-changing (doctors).

**Acceptance:** Both modes return correct availability for the same seeded merchant.

### T3.9 Hold and confirm
```
Buyer selects slot
  → POST /hold on the adapter, 15-minute duration
  → write slot_holds row with expires_at
  → price is now locked to the hold response
  → Razorpay order created on merchant account for the held price
  → on payment.captured → POST /confirm with payment_reference
  → store booking_ref on order_items
  → on payment failure or hold expiry → POST /release
```

Sweeper every 2 minutes releases expired holds.

**Race condition to handle explicitly:** hold expires between payment capture and confirm. On a failed confirm after successful payment, do **not** silently fail — mark the order `confirmation_failed`, alert ops, notify the merchant, and initiate a refund on their account.

**Acceptance:** Happy path books correctly. A forced hold expiry after payment triggers the refund path, not a silent loss.

### T3.10 Booking display
Bookings need different fields to products: date, time, duration, location, participant details, cancellation window. Extend `order_items` rendering and the MCP `get_order_status` response accordingly.

**Acceptance:** A doctor's appointment order shows date, time, clinic address, and the cancellation deadline.

---

## Block D — Live-priced flow

### T3.11 Quote-to-lock checkout
```
search → live quote (indicative, 60s cache)
  → buyer selects → fresh POST /quote for that exact option
  → price may differ from search: show the delta explicitly, never silently
  → buyer confirms new price → hold (if supported) or immediate order creation
  → Razorpay order at the confirmed price
```

**Never charge a price the buyer did not see.** If the fresh quote differs, the buyer re-confirms.

**Acceptance:** A seeded adapter that returns a higher price on the second call surfaces the change and requires re-confirmation.

### T3.12 MCP tool: `check_availability`
```
Input:  product_id, params{}, quantity, date_from?, date_to?
Output: options[] with real prices and validity, or unavailable_reason
```

This is a separate tool from `search_products` on purpose — the model calls it after narrowing, so you pay adapter latency only when it matters.

**Acceptance:** Model correctly calls `search_products` then `check_availability` for a hotel query, not the reverse.

---

## Block E — Quotation flow

### T3.13 RFQ submission
MCP tool `request_quote(product_id, fields{}, contact{})`. Validates `fields` against the product's `rfq_fields` schema. Creates a `quotations` row, calls the merchant's `/rfq` if they have an adapter, otherwise emails them a response link.

**Acceptance:** RFQ reaches the merchant by both paths.

### T3.14 Merchant quotation response
Dashboard screen listing open RFQs with buyer requirements. Merchant enters amount, notes, and validity. Also exposed as `POST /adapters/quotations/{rfq_ref}/respond` for adapter-based merchants.

On response: notify the buyer by email and, if they have an active session, in chat.

**Acceptance:** Merchant responds; buyer receives the quotation within a minute.

### T3.15 Quotation acceptance and payment
Buyer views the quotation on a shareable page, accepts, and a Razorpay order is created on the merchant's account for the quoted amount. Quotations expire at `valid_until`.

**Acceptance:** Accepted quotation produces a payable order. An expired one cannot be paid.

---

## Block F — Cross-merchant cart

### T3.16 Multi-merchant checkout
The cart already spans merchants from Phase 2. Now it must span archetypes — a physical item, a booking, and a live-priced item in one session.

Sequencing:
1. Lock all live prices and place all holds **first**
2. Then create one Razorpay order per merchant
3. Then payment, sequentially
4. Then confirm all bookings

**If any hold fails at step 1, stop before taking any money.** This ordering is the whole design.

**Acceptance:** A cart with a product, a hotel night, and a flight quote either fully succeeds or fails before any payment is taken.

### T3.17 Partial failure recovery
Extend Phase 2's handling: successful merchants keep their orders; failed ones are individually retriable; holds for failed merchants are released immediately.

**Acceptance:** Forced failure on the second of three merchants leaves two valid orders, one released hold, and one clear retry.

---

## Block G — Fulfillment and post-purchase

### T3.18 Merchant order management
Dashboard: order list, filters by status, detail view, status transitions (acknowledge → packed → shipped → delivered), AWB and tracking URL entry, cancel with reason.

Every transition writes `order_events` and notifies the buyer.

**Acceptance:** Merchant moves an order through the full lifecycle; buyer sees each step.

### T3.19 Buyer order tracking
Timeline UI. `get_order_status` MCP tool returns the real state so "where's my order" works in chat.

**Acceptance:** Asking Claude about an order returns the current real status with the timeline.

### T3.20 Reviews
Request 2 days after `delivered`, by email and in-portal. Capture rating 1–5, optional text, and `delivered_on_time` yes/no. One review per order. No merchant editing or deletion — they may respond, not remove.

**Acceptance:** Review request fires on schedule; submitted review updates `merchant_metrics` on the next nightly run.

### T3.21 Fulfillment score
Extend the nightly metrics worker:
```
fulfillmentScore =
    0.40·onTimeDeliveryRate
  + 0.25·orderAcceptanceRate    (acknowledged within 6h / total)
  + 0.20·avgRating/5
  + 0.15·(1 - cancellationRate)
```
Feeds `trust_score`. New merchants at 0.70 neutral until 10 completed orders.

**Acceptance:** Seeded order history produces the hand-calculated score. A merchant who stops acknowledging orders sees their score drop within 24h.

### T3.22 Refund flow
Buyer requests via the portal. Routed to the merchant. Merchant approves and we call Razorpay refund **on their account** with their token. Track in `order_events`. Surface the merchant's stated return window from `merchant_policies` at request time so expectations are set by their own policy.

**Acceptance:** Refund executes on the merchant's account and reflects in the buyer's order timeline.

---

## Phase 3 exit checklist

- [ ] Adapter contract published; conformance suite catches broken adapters
- [ ] Sheets-backed adapter lets a non-technical merchant go live
- [ ] Circuit breaker isolates a failing merchant without affecting others
- [ ] Fan-out with one hanging adapter returns in under 2.2s
- [ ] Hotel night books end to end: hold → pay → confirm
- [ ] Doctor's appointment books with correct slot semantics
- [ ] Hold-expired-after-payment triggers refund, not silent loss
- [ ] Live price change between search and checkout requires re-confirmation
- [ ] Quotation flows request → respond → accept → pay
- [ ] Mixed cart across three archetypes succeeds or fails atomically before payment
- [ ] Order tracking works in chat via `get_order_status`
- [ ] Reviews collected; fulfillment score computes correctly
- [ ] Refund executes on the merchant's own account
