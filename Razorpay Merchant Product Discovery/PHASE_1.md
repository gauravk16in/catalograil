# PHASE 1 — Foundation, Catalog Intelligence, Merchant Dashboard

**Objective:** A merchant onboards with Razorpay, uploads products, and those products become semantically searchable at variant level via an internal API in under 200ms.

**Ships:** `SIMPLE` and `VARIANT` archetypes only. The other three are in the schema but not exposed.

**Exit criterion:** Seeded with 3 merchants across 3 different verticals, `POST /internal/search` returns correct variant-level results for 20 hand-written test queries with ≥80% top-3 relevance, p95 under 200ms.

Read `00_PROJECT_CONTEXT.md` first. Do not deviate from the schema there.

---

## Block A — Infrastructure and scaffolding

### T1.1 Monorepo scaffold
Create the pnpm workspace and Turborepo pipeline exactly as laid out in the context file, section 5.

- Root `package.json` with workspaces, `turbo.json` with `build`, `test`, `lint`, `typecheck` tasks
- `tsconfig.base.json` with strict mode, ESM, `moduleResolution: bundler`
- Shared ESLint + Prettier config in `/packages/config`
- `.env.example` covering every variable used anywhere in the repo

**Acceptance:** `pnpm install && pnpm build` succeeds from clean checkout.

### T1.2 Verify Bedrock model access — do this before anything else
Write a throwaway script `scripts/verify-bedrock.ts` that:
- Calls `cohere.embed-v4` in `ap-south-1` with a text input and an image input
- If unavailable, tries cross-region inference profiles
- Falls back to `amazon.titan-embed-text-v2:0` + `amazon.titan-embed-image-v1`
- Prints which model IDs are usable, their dimensions, and measured latency

**Acceptance:** Script prints a working model ID for both text and image. Record the result in `/packages/embeddings/MODELS.md`. Every later task depends on this answer.

### T1.3 CDK infrastructure — data stack
`/infra/stacks/data-stack.ts`

- Aurora Serverless v2 PostgreSQL 16, min 0.5 ACU / max 4 ACU in dev
- RDS Proxy with IAM auth, in the same VPC as Lambdas
- Enable extensions on first boot: `vector`, `ltree`, `pg_trgm`, `uuid-ossp`
- DynamoDB tables per context section 7, on-demand, TTL attribute `ttl` on all
- S3 buckets: `uploads` (private, presigned only), `product-images` (CloudFront fronted), `exports`
- KMS key for token encryption

**Acceptance:** `cdk deploy DataStack --context env=dev` succeeds. A psql session through RDS Proxy can `SELECT extversion FROM pg_extension WHERE extname='vector'`.

### T1.4 CDK — queue stack
`/infra/stacks/queue-stack.ts`

Queues, each with a DLQ (`maxReceiveCount: 3`) and a CloudWatch alarm on DLQ depth > 0:
`ingestion`, `enrichment`, `embedding`, `notification`, `policy-check`

**Acceptance:** All queues deployed, DLQs attached, alarms present in CloudWatch.

### T1.5 Database schema and migrations
`/packages/db`

- Drizzle schema files per context section 6, split by domain
- `drizzle-kit` migration generating the full schema including HNSW and GIN indexes
- A `seed` script that creates 3 merchants and ~60 products across 3 verticals (electronics, apparel with variants, a service) for testing
- Connection helper that uses RDS Proxy + IAM auth, with connection reuse across Lambda invocations

**Acceptance:** Migration applies cleanly to an empty database. `pnpm db:seed` populates it. `\d searchable_units` shows all three HNSW indexes.

**Important:** create the Phase 3 tables (`adapters`, `slots`, `slot_holds`, `quotations`) now. Retrofitting them later is a full migration.

---

## Block B — Merchant onboarding

### T1.6 Razorpay OAuth flow
`/packages/razorpay` + `/services/api-merchant/handlers/oauth`

Three endpoints:
- `GET /merchant/oauth/start` — generate `state` (UUID, stored in DynamoDB with 10-minute TTL), redirect to `https://auth.razorpay.com/authorize` with `client_id`, `redirect_uri`, `response_type=code`, `scope`, `state`
- `GET /merchant/oauth/callback` — validate `state`, exchange code at the token endpoint, fetch account details, upsert `merchants` + `merchant_tokens`, issue our own session JWT, redirect to dashboard
- `POST /merchant/oauth/revoke`

Tokens are KMS-encrypted before insert. `access_expires_at` and `refresh_expires_at` computed from the response.

**Acceptance:** Full round trip against Razorpay test mode creates a merchant row with a decryptable token. Replaying a used `state` is rejected.

### T1.7 Token refresh worker
`/services/workers/token-refresh`

EventBridge rule, daily at 02:00 IST. Selects merchants where `access_expires_at < now() + interval '14 days'`, refreshes, updates. On failure: increment a counter, email the merchant, and after 3 failures set `merchants.status = 'suspended'`.

**Acceptance:** A merchant with an artificially near-expiry token is refreshed on the next run. A merchant with a revoked token is suspended after 3 attempts and their products vanish from search.

### T1.8 Merchant profile and capability declaration
`POST /merchant/profile`, `PUT /merchant/profile`, `POST /merchant/capabilities`

Capability options are `catalog`, `live_price`, `bookable`, `quote`. In Phase 1 only `catalog` can be enabled; the others accept the declaration and store it but return `"available_in_phase_3": true`.

**Acceptance:** Merchant can declare `catalog` and reach `status='active'` after policy validation (T1.9) passes.

### T1.9 Policy capture and validation
`/services/workers/policy-checker` + `POST /merchant/policies`

At onboarding, the merchant must supply three URLs: refund, terms, fulfillment. These are **mandatory** — a merchant cannot reach `active` without them.

On submission and weekly thereafter:
1. Fetch each URL. Require HTTP 200 and > 200 characters of body text.
2. Extract text, send to Claude with a structured extraction prompt returning: `return_window_days`, `return_shipping_by`, `dispatch_sla_hours`, and a two-sentence plain-English summary of each policy.
3. Store summaries and structured fields on `merchant_policies`.
4. On failure: increment `consecutive_failures`, notify merchant. At 3, suspend the merchant.

**Acceptance:** Given a real returns page URL, the extractor produces a correct `return_window_days`. A 404 URL blocks activation with a clear error.

---

## Block C — Ingestion

### T1.10 CSV template and validator
`/packages/core/src/csv`

Two templates, downloadable from the dashboard:
- `simple-products.csv`: `external_ref, name, brand, description, category_hint, price, mrp, stock, delivery_days, weight_grams, image_url_1..3`
- `variant-products.csv`: `external_ref, name, brand, description, category_hint, option_axis_1_name, option_axis_1_value, option_axis_2_name, option_axis_2_value, option_axis_3_name, option_axis_3_value, sku, price, mrp, stock, delivery_days, image_url_1..3` — one row per variant, rows sharing `external_ref` collapse into one product

Validator: Zod schema per row, plus file-level checks (headers exact match, no duplicate SKU within file, price > 0, at least one image).

**Reject the entire file on a header mismatch.** A half-imported 500-row file is worse than a clean failure.

**Acceptance:** A valid variant CSV of 200 rows collapses into the right product/variant counts. A file with a typo'd header is rejected with the offending header named.

### T1.11 Upload endpoint and ingestion worker
`POST /merchant/uploads` returns a presigned S3 PUT URL scoped to `uploads/{merchantId}/{jobId}.csv`.

S3 `ObjectCreated` → SQS `ingestion` → `/services/workers/ingestion`:
1. Create `ingestion_jobs` row, status `running`
2. Stream-parse the CSV (do not load into memory — files may be large)
3. Validate row by row, collecting errors with row numbers, capped at 500 stored errors
4. Group variant rows by `external_ref`, upsert `products` + `product_option_axes` + `product_variants` in a transaction per product
5. Set `products.status = 'draft'` and enqueue each product to `enrichment`
6. On completion, write counts and email the merchant a summary with an error CSV attached

**Acceptance:** A 500-row file completes in under 60 seconds. A file with 10 bad rows imports 490 and reports the 10 with row numbers. Re-uploading the same file updates rather than duplicates (matched on `merchant_id` + `external_ref`).

### T1.12 Manual product form endpoints
`POST /merchant/products`, `PUT /merchant/products/:id`, `DELETE` (soft, sets `archived`)

Synchronous write, returns 201 immediately, enqueues enrichment. Variant products accept the option axes and a variant matrix in one payload.

**Acceptance:** A 3-axis variant product with 24 combinations is created in one call and produces 24 `product_variants` rows.

---

## Block D — Enrichment and embeddings

### T1.13 Enrichment worker
`/services/workers/enrichment`

Batch 20 products per Claude call. Prompt returns strict JSON per product:
```
{ external_ref, category_slug, category_path, attributes{},
  use_cases[], target_audience[], occasions[], keywords[],
  confidence: 0..1 }
```

Rules:
- If `category_slug` is unknown and `confidence >= 0.8`, auto-create the category with `review_status='approved'`
- If `confidence < 0.8`, create with `review_status='pending_review'` and add to the admin queue
- Write results with `enrichment_source` marking every field `ai`
- Never overwrite a field where `enrichment_source` is already `human`

Use `claude-haiku-4-5` for cost. Retry once on malformed JSON, then DLQ.

**Acceptance:** 60 seeded products are enriched in under 2 minutes. Categories are created sensibly. Re-running does not overwrite merchant edits.

### T1.14 Canonical text composer
`/packages/embeddings/src/canonical.ts`

Compose exactly this, omitting empty lines:
```
{name} — {brand}
{category_path}
{key attributes as "k: v", max 10, sorted by key}
{description truncated to 400 tokens}
Used for: {use_cases}
Suited to: {target_audience}
Occasions: {occasions}
Available in: {option axes summary}       ← VARIANT only
Route/scope: {route_or_scope}             ← LIVE_PRICED only
Typically: {price_range_hint}, delivered in {delivery_days} days
```

`contentHash = sha256(canonicalText)`. Export a pure function; it must be unit-testable with no I/O.

**Acceptance:** Unit tests prove the hash is stable across reordering of `attributes` keys, and that changing `price_paise` does not change the hash.

### T1.15 Embedding worker
`/services/workers/embedding`

For each product:
1. Expand into searchable units — one per variant for `VARIANT`, one per product for `SIMPLE`
2. Compose canonical text per unit
3. Compare `content_hash` against the existing row. **If unchanged, update only the denormalised filterable columns and exit.** This is the cost control; make it the first branch.
4. If changed: generate `v_semantic` (canonical text), `v_intent` (use-cases + audience only), `v_visual` (primary image) via Bedrock
5. Upsert `searchable_units`, set `embedding_status='indexed'`
6. On failure after 2 retries, set `failed` and DLQ

Batch Bedrock calls where the model supports it. Cache image embeddings by image URL hash — merchants reuse images across variants constantly.

**Acceptance:** 60 products expand to the correct unit count with all three vectors populated. Editing a description re-embeds exactly that unit; editing a price re-embeds nothing. A deliberately broken image URL fails gracefully with `v_visual` null and the row still indexed.

### T1.16 Denormalisation sync
A Postgres trigger or a lightweight worker keeps `searchable_units` filterables in sync when `product_variants.price_paise`, `.stock`, `.delivery_days`, `merchants.status`, or `merchant_metrics.trust_score` change.

**Recommendation:** trigger on the source tables writing directly to `searchable_units`, not a queue. Stock changes must reflect in search within a second, and a queue hop cannot promise that.

**Acceptance:** Setting a variant's stock to 0 removes it from `in_stock=true` results within 1 second. Suspending a merchant removes their entire catalog within 1 second.

---

## Block E — Search

### T1.17 Hybrid search query
`/packages/search/src/query.ts`

One SQL statement. Structure:

```sql
WITH filtered AS (
  SELECT id FROM searchable_units
  WHERE merchant_status = 'active'
    AND embedding_status = 'indexed'
    AND ($inStockOnly IS FALSE OR in_stock = true)
    AND ($maxPrice IS NULL OR price_paise <= $maxPrice)
    AND ($minPrice IS NULL OR price_paise >= $minPrice)
    AND ($categoryPath IS NULL OR category_path <@ $categoryPath)
    AND ($maxDeliveryDays IS NULL OR delivery_days <= $maxDeliveryDays)
    AND ($attrs IS NULL OR attributes @> $attrs)
),
sem AS (
  SELECT id, RANK() OVER (ORDER BY v_semantic <=> $qvec) AS r
  FROM searchable_units WHERE id IN (SELECT id FROM filtered)
  ORDER BY v_semantic <=> $qvec LIMIT 100
),
intent AS (
  SELECT id, RANK() OVER (ORDER BY v_intent <=> $qvec) AS r
  FROM searchable_units WHERE id IN (SELECT id FROM filtered)
  ORDER BY v_intent <=> $qvec LIMIT 100
),
lex AS (
  SELECT id, RANK() OVER (ORDER BY ts_rank_cd(tsv, $tsq) DESC) AS r
  FROM searchable_units
  WHERE id IN (SELECT id FROM filtered) AND tsv @@ $tsq
  LIMIT 100
)
SELECT id, SUM(w / (60 + r)) AS fusion
FROM ( SELECT id, r, 1.0 w FROM sem
       UNION ALL SELECT id, r, 0.6 FROM intent
       UNION ALL SELECT id, r, 0.8 FROM lex ) u
GROUP BY id ORDER BY fusion DESC LIMIT 30;
```

Set `SET LOCAL hnsw.ef_search = 100` per query for recall.

**Acceptance:** Returns in under 60ms against a 50k-unit dataset. `EXPLAIN ANALYZE` confirms the HNSW indexes are used, not sequential scans.

### T1.18 Business re-rank
`/packages/search/src/rerank.ts`

```
final = 0.55·normalise(fusion)
      + 0.20·trust_score
      + 0.15·deliverySpeedScore     -- 1.0 at ≤2 days, linear to 0 at 10 days
      + 0.10·freshnessScore         -- 1.0 if updated <24h, decaying to 0.3 at 30d
```

New-merchant cap: if `is_new_merchant`, clamp the trust contribution to 0.6× and mark the result.

**Acceptance:** Unit tests cover: a cheap slow item does not outrank a slightly pricier fast one when `delivery_by` is set; a 3-order merchant does not top a 400-order merchant on trust alone.

### T1.19 Internal search API
`POST /internal/search`

Request: `{ query?, imageUrl?, filters: { maxPrice, minPrice, categorySlug, maxDeliveryDays, attributes, inStockOnly }, limit }`

Pipeline: validate → check `QueryCache` for the query embedding by hash → embed if miss → hybrid query → rerank → hydrate top N with product/merchant/policy data → log to `SearchLogs`.

**No LLM call anywhere in this path.**

Response per item includes `why_this_matched` — a templated one-liner built from which signals fired (matched use case, attribute match, price fit), not generated text.

**Acceptance:** p95 under 200ms warm. Every response includes `price_as_of`. Empty results include `no_results_reason`.

### T1.20 Search logging
Write every search to DynamoDB `SearchLogs`: query text, filters, embedding cache hit, returned unit IDs in order, per-stage latency, result count. This is your only debugging tool and your future ranker training set. Do not skip it.

**Acceptance:** 100 searches produce 100 log entries queryable by day.

---

## Block F — Merchant dashboard

### T1.21 Auth and shell
`/apps/merchant`

Next.js App Router. "Connect with Razorpay" → OAuth → session cookie (httpOnly, SameSite=Lax, 7 days). Middleware guards all routes. Shell with nav: Products, Uploads, Policies, Preview in AI, Settings.

### T1.22 Onboarding wizard
Steps: business details → capability declaration → policy URLs (with live validation feedback) → status. Show a clear blocked state if policy validation fails, with the specific reason.

**Acceptance:** A new merchant completes all steps and reaches `active`.

### T1.23 Product management
- List with search, category filter, status filter, bulk archive
- Create/edit form branching on archetype
- Variant editor: define axes, auto-generate the combination matrix, per-variant price/stock/SKU, bulk-set price across the matrix
- Image upload with presigned PUT and client-side resize
- **Enrichment chips:** AI-suggested use cases, audience, occasions, keywords rendered as editable chips. Accepting or editing flips `enrichment_source` to `human` for that field. Show a subtle "AI suggested" marker on untouched chips.

**Acceptance:** A merchant creates a 24-variant product, edits two AI-suggested use cases, and the edit survives a re-run of the enrichment worker.

### T1.24 CSV upload UI
Template download, drag-drop upload, live job progress polled from `ingestion_jobs`, downloadable error CSV on completion.

### T1.25 Preview in AI
The retention feature. A search box where the merchant types a shopper query and sees the real ranked results, with their own products highlighted and their rank shown. Below each of their results, show which signals contributed to the score.

If their product does not appear in the top 20, show why: filtered out on price, on stock, on delivery, or simply low relevance. This turns the dashboard into a tool merchants open daily.

**Acceptance:** Merchant searches a query their product should match, sees its rank, and sees a concrete reason when it does not rank.

---

## Phase 1 exit checklist

- [ ] `cdk deploy` from clean state brings up dev end to end
- [ ] Merchant completes OAuth → capabilities → policies → `active`
- [ ] Policy extraction returns correct `return_window_days` for 3 real URLs
- [ ] 500-row variant CSV imports in under 60s with correct product/variant collapse
- [ ] Malformed CSV rejected with row-level errors
- [ ] 60 seeded products enriched and embedded; unit counts correct
- [ ] Editing a price re-embeds nothing; editing a description re-embeds one unit
- [ ] Stock → 0 disappears from search within 1s
- [ ] Merchant suspension removes catalog within 1s
- [ ] Token refresh worker refreshes a near-expiry token
- [ ] `/internal/search` p95 under 200ms on 50k units
- [ ] 20 hand-written test queries score ≥80% top-3 relevance (manual scoring, record the sheet)
- [ ] Every search logged
- [ ] All DLQs empty; alarms verified by a deliberate poison message
- [ ] Preview in AI shows a real rank and a real reason for non-ranking
