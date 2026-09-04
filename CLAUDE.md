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

| #   | Decision            | Value                                                                                                                     |
| --- | ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| D1  | Catalog datastore   | **Aurora Serverless v2 PostgreSQL 16 + pgvector**                                                                         |
| D2  | Ephemeral datastore | **DynamoDB** (sessions, idempotency, logs, caches)                                                                        |
| D3  | Commission          | **Zero.** Merchant is merchant of record.                                                                                 |
| D4  | Payment             | Razorpay Order/Payment Link created **on the merchant's account** via their OAuth token                                   |
| D5  | Embedding model     | `cohere.embed-v4` on Bedrock, 1024 dims, `int8`. Fallback: `amazon.titan-embed-text-v2:0` + `amazon.titan-embed-image-v1` |
| D6  | Searchable unit     | **The variant, not the product.** For live/bookable archetypes, the offering.                                             |
| D7  | Verticals           | All. Five archetypes (below).                                                                                             |
| D8  | Region              | `ap-south-1` (Mumbai) primary. Bedrock via cross-region inference if Embed v4 is unavailable there — verify in Task 1.2.  |

If you are overriding D1, stop and say so before writing code. Everything in `/packages/db` assumes Postgres.

---

## 3. The five archetypes

Every product declares exactly one. This drives schema, embedding text, MCP response shape, and checkout flow.

| Archetype     | Example                              | Price source          | Inventory     | Checkout                       |
| ------------- | ------------------------------------ | --------------------- | ------------- | ------------------------------ |
| `SIMPLE`      | Dashcam                              | Static                | Stock count   | Buy now                        |
| `VARIANT`     | Shirt, size × colour × fabric        | Per variant           | Per variant   | Select variant → buy           |
| `LIVE_PRICED` | Flight, cab fare                     | Adapter at query time | Live          | Quote → lock → pay             |
| `BOOKABLE`    | Movie seat, hotel night, doctor slot | Per slot              | Slot calendar | Select slot → hold → pay       |
| `QUOTE`       | Custom fabrication, catering         | Merchant responds     | N/A           | RFQ → quotation → accept → pay |

Phase 1 ships `SIMPLE` and `VARIANT` only. Phase 3 adds the other three. **Design the schema for all five in Phase 1** — retrofitting them later means a full migration.

---

## 4. Stack

| Layer         | Choice                                                      |
| ------------- | ----------------------------------------------------------- |
| Language      | TypeScript, Node 20, ESM                                    |
| Monorepo      | pnpm workspaces + Turborepo                                 |
| Infra         | AWS CDK v2 (TypeScript)                                     |
| Compute       | Lambda (ARM64, `arm64` graviton)                            |
| API           | API Gateway HTTP API                                        |
| Catalog DB    | Aurora Serverless v2 PostgreSQL 16, pgvector, RDS Proxy     |
| ORM           | Drizzle ORM + drizzle-kit migrations                        |
| Ephemeral DB  | DynamoDB on-demand                                          |
| Queues        | SQS (+ DLQ on every queue, no exceptions)                   |
| Object store  | S3                                                          |
| AI            | Bedrock (embeddings), Anthropic API (enrichment, chat pane) |
| Email         | SES                                                         |
| Frontend      | Next.js 15 App Router, Tailwind, shadcn/ui                  |
| Validation    | Zod — shared schemas in `/packages/core`                    |
| Testing       | Vitest (unit), Playwright (e2e)                             |
| Observability | Powertools for AWS Lambda (logger, tracer, metrics)         |

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

| Table             | PK / SK                                 | TTL | Purpose                                               |
| ----------------- | --------------------------------------- | --- | ----------------------------------------------------- |
| `Sessions`        | `SESSION#<id>` / `META`                 | 24h | Chat sessions, cart state, handoff context            |
| `IdempotencyKeys` | `KEY#<hash>` / `META`                   | 48h | Razorpay webhooks, checkout creation                  |
| `QueryCache`      | `Q#<queryHash>` / `META`                | 24h | Query embeddings, resolved filters                    |
| `AdapterCache`    | `ADPT#<adapterId>#<paramHash>` / `META` | 60s | Live price/slot responses                             |
| `SearchLogs`      | `DAY#<yyyy-mm-dd>` / `TS#<ts>#<id>`     | 90d | Every search: query, filters, results, latency, click |
| `RateLimits`      | `RL#<subject>` / `WINDOW#<bucket>`      | 5m  | Per-IP and per-session throttling                     |

---

## 8. Non-negotiable rules

**Data integrity**

1. Every SQS queue has a DLQ. Alarm on `ApproximateNumberOfMessagesVisible > 0`.
2. Every external webhook handler is idempotent via `IdempotencyKeys` conditional write.
3. Never store a Razorpay token unencrypted. KMS envelope encryption, decrypt in-memory only.
4. Snapshot merchant policies onto the order at purchase time. Policies change; the buyer's contract does not.

**Search correctness** 5. Hard constraints are SQL `WHERE` exclusions, never score penalties. An item that cannot arrive in time must not appear because it is cheap. 6. Never return more than 5 results from an MCP tool. 7. Every price in every response carries `price_as_of`. No bare numbers. 8. Empty results return a `no_results_reason` sentence, so the model states a fact instead of inventing one. 9. Re-embed only when `content_hash` changes. Price and stock updates must never trigger re-embedding.

**Performance** 10. No LLM call inside the synchronous search path. The calling model already parsed intent — take structured params. 11. RDS Proxy for all Lambda→Aurora connections. Never connect directly. 12. Adapter fan-out: 2s hard timeout, circuit breaker at 3 consecutive failures.

**Money** 13. All amounts are `bigint` paise. Never floats. Format for display at the edge only. 14. Payment objects are created on the **merchant's** Razorpay account, using their token. Never ours. 15. If a merchant's token is expired, their products are excluded from search — not shown and failed at checkout.

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

| Env       | Aurora    | Notes                                                |
| --------- | --------- | ---------------------------------------------------- |
| `dev`     | 0.5–1 ACU | Razorpay test mode, Bedrock on-demand                |
| `staging` | 0.5–2 ACU | Razorpay test mode, full e2e suite runs here         |
| `prod`    | 1–8 ACU   | Razorpay live, provisioned concurrency on MCP Lambda |

---

## 11. Phase documents

The task breakdowns live alongside this file's source in
[Razorpay Merchant Product Discovery/](Razorpay%20Merchant%20Product%20Discovery/):

| File                                                               | Contents                                                          |
| ------------------------------------------------------------------ | ----------------------------------------------------------------- |
| [PHASE_1.md](Razorpay%20Merchant%20Product%20Discovery/PHASE_1.md) | Foundation, catalog intelligence, merchant dashboard (T1.1–T1.25) |
| [PHASE_2.md](Razorpay%20Merchant%20Product%20Discovery/PHASE_2.md) | MCP server, image search, payments, split-screen surface          |
| [PHASE_3.md](Razorpay%20Merchant%20Product%20Discovery/PHASE_3.md) | Live inventory, bookings, quotations, fulfillment                 |
| [PHASE_4.md](Razorpay%20Merchant%20Product%20Discovery/PHASE_4.md) | Ranking quality, intelligence, connectors, expansion              |

Every task carries an **Acceptance** line. That is the definition of done — do not mark a
task complete without meeting it. A phase's exit checklist is the next phase's prerequisite.

---

## 12. Commands

```bash
pnpm install                 # all 24 workspace projects
pnpm build                   # turbo run build across the graph
pnpm typecheck               # tsc --noEmit everywhere
pnpm test                    # vitest run everywhere
pnpm lint
pnpm format

# one package at a time
pnpm --filter @catalograil/core test
pnpm --filter @catalograil/core exec vitest run src/money/paise.test.ts    # a single file
pnpm --filter @catalograil/core exec vitest run -t 'Indian digit grouping' # a single test

# database
pnpm db:generate             # drizzle-kit generate (bundles the schema first — see below)
pnpm db:migrate              # apply migrations; needs DATABASE_URL
pnpm db:seed                 # 3 merchants, 60 products, 233 variants; idempotent
pnpm db:studio

# infra (needs AWS credentials)
pnpm --filter @catalograil/infra exec cdk synth --context env=dev
pnpm --filter @catalograil/infra exec cdk deploy DataStack --context env=dev

pnpm verify:bedrock          # T1.2; rewrites packages/embeddings/MODELS.md
```

### Local database

A local Postgres with pgvector stands in for Aurora during development:

```bash
brew install postgresql@18 pgvector
createdb catalograil
export DATABASE_URL="postgres://$(whoami)@localhost:5432/catalograil"
pnpm db:migrate && pnpm db:seed
```

`db:migrate` creates the `vector`, `ltree`, `pg_trgm` and `uuid-ossp` extensions itself; in
deployed environments the data stack creates them on first boot instead (T1.3). The local
server is PG18 while Aurora targets PG16 — nothing in the schema depends on the difference,
but a future migration that does should be caught before it ships.

### Two wrinkles worth knowing

**drizzle-kit and ESM.** drizzle-kit loads the schema through a CJS `require`, which cannot
resolve the `.js` specifiers correct Node ESM source needs. So `db:generate` first bundles
`src/schema/index.ts` into `.drizzle/schema.cjs` via
[packages/db/scripts/bundle-schema.ts](packages/db/scripts/bundle-schema.ts), keeping
`drizzle-orm` external so drizzle-kit and the bundle share one copy of the library. Edit the
schema files, never the bundle.

**CHECK constraints come from TypeScript.** Status and archetype constraints are generated
from the constant arrays in `@catalograil/core` via the `inList` helper in
[packages/db/src/schema/_shared.ts](packages/db/src/schema/_shared.ts). Add a status to the
constant, regenerate, and the database constraint follows. Never hand-write the SQL list.

---

## 13. Progress

| Task                            | State                                                             |
| ------------------------------- | ----------------------------------------------------------------- |
| T1.1–T1.25 (all of Phase 1)     | ✅ done — every acceptance criterion measured, not assumed        |
| T1.2 verify Bedrock access      | ✅ done — Embed v4 reachable, 1024 dims, both text and image      |
| Deployed to `dev` (ap-south-1)  | ✅ Network, Queue, Data, Worker, Api, Frontend                    |

Account **149561018240** (`catalog-rail`) is the deployment account. A second account,
124074140058, holds a Bedrock API key that has no valid payment instrument — it is not used
by anything and `AWS_BEARER_TOKEN_BEDROCK` is commented out in `.env.local` because both the
CLI and the JS SDK prefer it over the profile, silently sending model calls to the wrong
account. Local runs must use `AWS_PROFILE=catalograil`.

`pnpm verify:bedrock` has been run and `packages/embeddings/MODELS.md` reflects the real
account: `global.cohere.embed-v4:0` for text and image at 1024 dims, which is what deployed
environments are configured with and what makes `vector(1024)` a fact rather than an
assumption. The defaults compiled into `BedrockEmbedder` deliberately stay on Embed v3 plus
Titan Multimodal, because that is what existing local databases were embedded with and the
two are the same width — switching model without re-embedding would mix vector spaces in
one column and quietly rot recall rather than fail.

Deploys must carry `GITHUB_TOKEN_SECRET_NAME`; `infra/bin/app.ts` drops the whole Frontend
stack without it, and because the deployed Frontend still imports the API endpoint,
deploying the Api stack alone then fails on an export that is still in use.

To get a deployed environment's catalogue into search, invoke the migration Lambda with
`{"seed": true}` and then `{"skipBootstrap": true, "backfill": true}` — nothing else
enqueues an existing catalogue for indexing.
