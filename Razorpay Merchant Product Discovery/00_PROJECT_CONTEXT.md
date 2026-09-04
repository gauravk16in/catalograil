# PROJECT CONTEXT — Read this first, every session

This file is the shared context for all four phases. Copy it to `CLAUDE.md` at the repo root.

---

## 1. What we are building

A merchant catalog platform that makes products and services from Indian merchants discoverable and purchasable **inside Claude and ChatGPT** via an MCP server.

- Merchants onboard with Razorpay OAuth, list products or expose live-inventory endpoints
- Buyers discover products in chat, compare them, and pay
- **Payment goes directly to the merchant's own Razorpay account. We never hold funds and take no commission.**
- Where a redirect is needed, it opens our own split-screen page: product on one side, live chat on the other

---

## 2. Locked decisions

| # | Decision | Value |
|---|---|---|
| D1 | Catalog datastore | **Aurora Serverless v2 PostgreSQL 16 + pgvector** |
| D2 | Ephemeral datastore | **DynamoDB** (sessions, idempotency, logs, caches) |
| D3 | Commission | **Zero.** Merchant is merchant of record. |
| D4 | Payment | Razorpay Order/Payment Link created **on the merchant's account** via their OAuth token |
| D5 | Embedding model | `cohere.embed-v4` on Bedrock, 1024 dims, `int8`. Fallback: `amazon.titan-embed-text-v2:0` + `amazon.titan-embed-image-v1` |
| D6 | Searchable unit | **The variant, not the product.** For live/bookable archetypes, the offering. |
| D7 | Verticals | All. Five archetypes (below). |
| D8 | Region | `ap-south-1` (Mumbai) primary. Bedrock via cross-region inference if Embed v4 is unavailable there — verify in Task 1.2. |

If you are overriding D1, stop and say so before writing code. Everything in `/packages/db` assumes Postgres.

---

## 3. The five archetypes

Every product declares exactly one. This drives schema, embedding text, MCP response shape, and checkout flow.

| Archetype | Example | Price source | Inventory | Checkout |
|---|---|---|---|---|
| `SIMPLE` | Dashcam | Static | Stock count | Buy now |
| `VARIANT` | Shirt, size × colour × fabric | Per variant | Per variant | Select variant → buy |
| `LIVE_PRICED` | Flight, cab fare | Adapter at query time | Live | Quote → lock → pay |
| `BOOKABLE` | Movie seat, hotel night, doctor slot | Per slot | Slot calendar | Select slot → hold → pay |
| `QUOTE` | Custom fabrication, catering | Merchant responds | N/A | RFQ → quotation → accept → pay |

Phase 1 ships `SIMPLE` and `VARIANT` only. Phase 3 adds the other three. **Design the schema for all five in Phase 1** — retrofitting them later means a full migration.

---

## 4. Stack

| Layer | Choice |
|---|---|
| Language | TypeScript, Node 20, ESM |
| Monorepo | pnpm workspaces + Turborepo |
| Infra | AWS CDK v2 (TypeScript) |
| Compute | Lambda (ARM64, `arm64` graviton) |
| API | API Gateway HTTP API |
| Catalog DB | Aurora Serverless v2 PostgreSQL 16, pgvector, RDS Proxy |
| ORM | Drizzle ORM + drizzle-kit migrations |
| Ephemeral DB | DynamoDB on-demand |
| Queues | SQS (+ DLQ on every queue, no exceptions) |
| Object store | S3 |
| AI | Bedrock (embeddings), Anthropic API (enrichment, chat pane) |
| Email | SES |
| Frontend | Next.js 15 App Router, Tailwind, shadcn/ui |
| Validation | Zod — shared schemas in `/packages/core` |
| Testing | Vitest (unit), Playwright (e2e) |
| Observability | Powertools for AWS Lambda (logger, tracer, metrics) |

---

## 5. Repo layout

```
/infra                    CDK app — one stack per phase, composable
  /stacks
    network-stack.ts
    data-stack.ts         Aurora, DynamoDB, S3
    queue-stack.ts        SQS + DLQs
    api-stack.ts          HTTP API + Lambda
    mcp-stack.ts          MCP server Lambda + provisioned concurrency
    worker-stack.ts       SQS consumers
/packages
  /core                   Zod schemas, shared types, constants, errors
  /db                     Drizzle schema, migrations, query builders
  /search                 Hybrid search: query build, RRF, business rerank
  /embeddings             Bedrock clients, canonical text composer, hashing
  /razorpay               OAuth, orders, payment links, webhook verify
  /adapters               Adapter contract types + HTTP client + circuit breaker
  /trust                  Trust score computation
/services
  /api-merchant           Merchant-facing Lambda handlers
  /api-buyer              Buyer-facing Lambda handlers
  /api-internal           Internal search + admin
  /mcp                    MCP server
  /workers
    ingestion             CSV parse + validate
    enrichment            Claude metadata generation
    embedding             Vector generation + upsert
    notification          SES + WhatsApp
    policy-checker        Weekly policy URL validation
    metrics               Nightly trust/fulfillment computation
    adapter-refresh       Live price cache warming
/apps
  /merchant               Next.js merchant dashboard
  /buyer                  Next.js buyer dashboard + split-screen surface
```

---

## 6. Full Postgres schema

Write this in `/packages/db/src/schema/`. One file per domain. This is the complete Phase-1-through-4 schema; create it all in Phase 1 even where columns go unused until Phase 3.

### merchants.ts

```sql
merchants
  id                  uuid pk
  business_name       text not null
  legal_name          text
  contact_email       text not null
  contact_phone       text
  gstin               text
  gstin_verified      boolean default false
  razorpay_account_id text unique
  status              text not null default 'pending'
                      -- pending | active | suspended | delisted
  categories          text[]
  city                text
  state               text
  onboarded_at        timestamptz
  created_at          timestamptz default now()
  updated_at          timestamptz default now()
  index on (status, created_at)

merchant_capabilities
  merchant_id         uuid fk -> merchants
  capability          text     -- catalog | live_price | bookable | quote
  config              jsonb    -- endpoint URLs, auth, schema hints
  enabled             boolean default true
  primary key (merchant_id, capability)

merchant_tokens
  merchant_id         uuid pk fk -> merchants
  access_token        text not null        -- KMS encrypted at rest
  refresh_token       text not null
  access_expires_at   timestamptz not null
  refresh_expires_at  timestamptz not null
  scopes              text[]
  last_refreshed_at   timestamptz
  index on (access_expires_at)             -- refresh worker scans this

merchant_policies
  merchant_id         uuid pk fk -> merchants
  refund_url          text not null
  terms_url           text not null
  fulfillment_url     text not null
  refund_summary      text                 -- Claude-extracted
  terms_summary       text
  fulfillment_summary text
  return_window_days  int
  return_shipping_by  text                 -- buyer | merchant | conditional
  dispatch_sla_hours  int
  last_checked_at     timestamptz
  last_check_status   text                 -- ok | unreachable | empty | changed
  consecutive_failures int default 0

merchant_metrics                            -- recomputed nightly
  merchant_id         uuid pk fk -> merchants
  orders_total        int default 0
  orders_fulfilled    int default 0
  orders_cancelled    int default 0
  on_time_deliveries  int default 0
  avg_rating          numeric(3,2)
  rating_count        int default 0
  avg_ack_minutes     int
  dispute_count       int default 0
  verification_score  numeric(4,3)
  trust_score         numeric(4,3)
  is_new_merchant     boolean default true
  computed_at         timestamptz
```

### catalog.ts

```sql
categories                                  -- auto-growing taxonomy
  id                  uuid pk
  parent_id           uuid fk -> categories
  slug                text unique not null
  name                text not null
  path                ltree                 -- enable ltree extension
  attribute_schema    jsonb                 -- expected attrs for this leaf
  review_status       text default 'approved'  -- approved | pending_review
  created_at          timestamptz default now()

products
  id                  uuid pk
  merchant_id         uuid fk -> merchants
  archetype           text not null         -- SIMPLE|VARIANT|LIVE_PRICED|BOOKABLE|QUOTE
  name                text not null
  brand               text
  description         text
  category_id         uuid fk -> categories
  attributes          jsonb default '{}'
  use_cases           text[]
  target_audience     text[]
  occasions           text[]
  keywords            text[]
  enrichment_source   jsonb                 -- per-field: ai|human|mixed
  images              text[]
  status              text default 'draft'  -- draft|active|archived
  -- LIVE_PRICED / BOOKABLE / QUOTE only
  route_or_scope      text
  price_range_hint    text
  adapter_id          uuid fk -> adapters
  rfq_fields          jsonb
  typical_turnaround_hours int
  created_at          timestamptz default now()
  updated_at          timestamptz default now()
  unique (merchant_id, external_ref)
  index on (merchant_id, status)
  index on (category_id)

product_variants
  id                  uuid pk
  product_id          uuid fk -> products on delete cascade
  sku                 text not null
  option_values       jsonb not null        -- {"size":"42","colour":"lilac"}
  price_paise         bigint
  mrp_paise           bigint
  stock               int default 0
  delivery_days       int
  weight_grams        int
  dimensions_cm       jsonb
  images              text[]
  status              text default 'active'
  unique (product_id, sku)

product_option_axes
  product_id          uuid fk -> products on delete cascade
  axis_name           text                  -- "size"
  axis_values         text[]                -- ["38","40","42"]
  display_order       int
  primary key (product_id, axis_name)
```

### searchable.ts — the retrieval table

This is the single table every search hits. It is denormalised on purpose. Populated by the embedding worker; never written to directly by API handlers.

```sql
searchable_units
  id                  uuid pk
  unit_type           text not null         -- variant | product | offering
  product_id          uuid fk -> products on delete cascade
  variant_id          uuid fk -> product_variants on delete cascade
  merchant_id         uuid not null
  archetype           text not null

  -- denormalised filterables (all indexed)
  category_id         uuid
  category_path       ltree
  price_paise         bigint                -- null for LIVE_PRICED/QUOTE
  in_stock            boolean
  delivery_days       int
  attributes          jsonb                 -- GIN indexed
  merchant_status     text
  trust_score         numeric(4,3)

  -- search
  canonical_text      text not null
  content_hash        text not null
  tsv                 tsvector generated always as
                        (to_tsvector('english', canonical_text)) stored
  v_semantic          vector(1024)
  v_visual            vector(1024)
  v_intent            vector(1024)
  embedding_version   text default 'v1'
  embedding_status    text default 'pending'  -- pending|indexed|failed

  updated_at          timestamptz default now()

  index using hnsw (v_semantic vector_cosine_ops) with (m=16, ef_construction=64)
  index using hnsw (v_visual   vector_cosine_ops) with (m=16, ef_construction=64)
  index using hnsw (v_intent   vector_cosine_ops) with (m=16, ef_construction=64)
  index using gin  (tsv)
  index using gin  (attributes jsonb_path_ops)
  index on (merchant_status, in_stock, price_paise)
  index on (embedding_status, updated_at)
```

### commerce.ts

```sql
buyers
  id, name, email, phone, email_verified, phone_verified,
  default_address_id, created_at
  unique index on email, unique index on phone

buyer_addresses
  id, buyer_id, label, recipient_name, recipient_phone,
  line1, line2, landmark, city, state, pincode, country,
  delivery_notes, is_default, created_at

orders
  id                  uuid pk
  order_number        text unique           -- human readable, e.g. ORD-2K4M9X
  buyer_id            uuid                  -- null for guest
  buyer_email         text not null
  buyer_phone         text
  merchant_id         uuid fk -> merchants
  shipping_address    jsonb                 -- snapshot, not FK
  subtotal_paise      bigint
  shipping_paise      bigint
  tax_paise           bigint
  total_paise         bigint
  status              text                  -- awaiting_payment|paid|confirmed|
                                            -- packed|shipped|delivered|
                                            -- cancelled|refunded|failed
  razorpay_order_id   text
  razorpay_payment_id text
  payment_link_url    text
  payment_expires_at  timestamptz
  source              text                  -- claude|chatgpt|web
  session_id          text
  policy_snapshot     jsonb                 -- merchant policies at purchase time
  created_at, updated_at
  index on (merchant_id, created_at)
  index on (buyer_email, created_at)
  index on (status, created_at)

order_items
  id, order_id, product_id, variant_id, slot_id,
  name_snapshot, sku_snapshot, options_snapshot jsonb,
  unit_price_paise, quantity, line_total_paise,
  promised_delivery_date

order_events
  id, order_id, event_type, actor, payload jsonb, created_at
  index on (order_id, created_at)

reviews
  id, order_id unique, buyer_id, merchant_id, product_id,
  rating int, title, body,
  delivered_on_time boolean, created_at
```

### phase3.ts — create in Phase 1, use in Phase 3

```sql
adapters
  id, merchant_id, capability, base_url, auth_type, auth_ref,
  timeout_ms default 2000, health_status, consecutive_failures,
  circuit_open_until, last_health_check_at, created_at

slots
  id, product_id, adapter_id,
  starts_at, ends_at, capacity, booked, price_paise,
  location jsonb, metadata jsonb, status
  index on (product_id, starts_at)

slot_holds
  id, slot_id, session_id, quantity, expires_at, status
  index on (expires_at)

quotations
  id, product_id, merchant_id, buyer_id, buyer_email,
  rfq_payload jsonb, status,           -- requested|quoted|accepted|expired|declined
  quoted_amount_paise, quoted_notes, valid_until,
  razorpay_order_id, created_at, responded_at
```

---

## 7. DynamoDB tables

| Table | PK / SK | TTL | Purpose |
|---|---|---|---|
| `Sessions` | `SESSION#<id>` / `META` | 24h | Chat sessions, cart state, handoff context |
| `IdempotencyKeys` | `KEY#<hash>` / `META` | 48h | Razorpay webhooks, checkout creation |
| `QueryCache` | `Q#<queryHash>` / `META` | 24h | Query embeddings, resolved filters |
| `AdapterCache` | `ADPT#<adapterId>#<paramHash>` / `META` | 60s | Live price/slot responses |
| `SearchLogs` | `DAY#<yyyy-mm-dd>` / `TS#<ts>#<id>` | 90d | Every search: query, filters, results, latency, click |
| `RateLimits` | `RL#<subject>` / `WINDOW#<bucket>` | 5m | Per-IP and per-session throttling |

---

## 8. Non-negotiable rules

**Data integrity**
1. Every SQS queue has a DLQ. Alarm on `ApproximateNumberOfMessagesVisible > 0`.
2. Every external webhook handler is idempotent via `IdempotencyKeys` conditional write.
3. Never store a Razorpay token unencrypted. KMS envelope encryption, decrypt in-memory only.
4. Snapshot merchant policies onto the order at purchase time. Policies change; the buyer's contract does not.

**Search correctness**
5. Hard constraints are SQL `WHERE` exclusions, never score penalties. An item that cannot arrive in time must not appear because it is cheap.
6. Never return more than 5 results from an MCP tool.
7. Every price in every response carries `price_as_of`. No bare numbers.
8. Empty results return a `no_results_reason` sentence, so the model states a fact instead of inventing one.
9. Re-embed only when `content_hash` changes. Price and stock updates must never trigger re-embedding.

**Performance**
10. No LLM call inside the synchronous search path. The calling model already parsed intent — take structured params.
11. RDS Proxy for all Lambda→Aurora connections. Never connect directly.
12. Adapter fan-out: 2s hard timeout, circuit breaker at 3 consecutive failures.

**Money**
13. All amounts are `bigint` paise. Never floats. Format for display at the edge only.
14. Payment objects are created on the **merchant's** Razorpay account, using their token. Never ours.
15. If a merchant's token is expired, their products are excluded from search — not shown and failed at checkout.

**Never do**
- Never use `SELECT *` on `searchable_units`; the vector columns are large.
- Never write to `searchable_units` from an API handler. Only the embedding worker writes there.
- Never let a merchant with fewer than 10 completed orders outrank an established one on trust alone.
- Never expose `merchant_tokens`, internal IDs, or adapter credentials in any MCP or public API response.

---

## 9. Conventions

- Zod schema for every API boundary, exported from `/packages/core`. Handler validates first, always.
- Error type: `AppError { code, message, httpStatus, retryable, details? }`. Codes are `SCREAMING_SNAKE`.
- Every Lambda uses Powertools logger with `correlationId` from the request. Log the ID in every line.
- Migrations are forward-only. No destructive migration without an explicit approval note in the PR.
- Feature flags in SSM Parameter Store, read at cold start, cached 5 minutes.
- All timestamps `timestamptz`, stored UTC, rendered in IST at the edge.

---

## 10. Environments

| Env | Aurora | Notes |
|---|---|---|
| `dev` | 0.5–1 ACU | Razorpay test mode, Bedrock on-demand |
| `staging` | 0.5–2 ACU | Razorpay test mode, full e2e suite runs here |
| `prod` | 1–8 ACU | Razorpay live, provisioned concurrency on MCP Lambda |
