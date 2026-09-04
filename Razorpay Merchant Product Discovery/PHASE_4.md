# PHASE 4 — Ranking Quality, Intelligence, Expansion

**Objective:** Move from "it works" to "it's better than the model's own knowledge." Phase 4 is not a fixed scope — it is a prioritised backlog. Work top to bottom.

**Prerequisites:** Phase 3 green. At least 10,000 logged searches and 500 completed orders before starting Block A — the learned components need data, and starting them early produces a model that memorises noise.

---

## Block A — Ranking quality (highest value, do first)

### T4.1 Search log enrichment
Before you can train anything, close the feedback loop. Extend `SearchLogs` to join:
- Which results were returned, in order
- Which result the buyer opened in the split-screen (click)
- Which was added to cart
- Which was purchased
- Whether the order was later cancelled or refunded

Write a nightly ETL into a Parquet dataset on S3, partitioned by date. Query with Athena.

**Acceptance:** A single Athena query returns click-through and conversion rate per search, per position.

### T4.2 Offline relevance benchmark
Build a golden set of 300 query→expected-result pairs across all verticals, hand-labelled. Score with NDCG@5 and MRR. Wire it into CI so a ranking change that regresses relevance fails the build.

This is the single most valuable thing in Phase 4. Without it, every subsequent ranking change is a guess.

**Acceptance:** `pnpm eval:relevance` prints NDCG@5. A deliberately broken weight regresses the score and fails CI.

### T4.3 Learned re-ranker
Replace the hand-tuned weights in `/packages/search/src/rerank.ts` with a gradient-boosted ranker (LightGBM via a Lambda container, or XGBoost).

Features: fusion score, each vector's individual similarity, BM25 score, price percentile within category, delivery days, trust components (individually, not the composite), merchant order volume, historical CTR for the unit, query-category match confidence, days since listing.

Train on purchase as the positive label, click as a weak positive, impression-without-click as negative. Hold out the most recent 2 weeks.

**Ship behind a flag with an A/B split.** Keep the hand-tuned ranker as the control and only cut over if NDCG@5 and conversion both improve.

**Acceptance:** New ranker beats the baseline on the golden set and in a two-week A/B before becoming default.

### T4.4 Zero-result and low-relevance mining
Nightly job clustering queries that returned nothing, or where nothing was clicked. Output two artefacts:
- **Merchant BD list:** demand you cannot serve, ranked by frequency. This is the highest-quality lead list you will ever have — go recruit exactly those merchants.
- **Synonym candidates:** query terms that should map to existing catalog terms but don't. Feed into a curated synonym table applied at query time.

**Acceptance:** Weekly report lists the top 50 unserved demand clusters with volume.

### T4.5 Per-category ranking weights
Delivery speed dominates for gifting; price dominates for commodities; trust dominates for services. Learn weights per top-level category rather than applying one global formula.

**Acceptance:** Category-specific weights beat global weights on the golden set.

### T4.6 Personalisation
For authenticated buyers, bias ranking on order history: preferred price band, brands purchased before, categories browsed. Keep it as a small additive term (max 0.10 weight) — heavy personalisation on a thin history is worse than none.

**Acceptance:** A buyer with three prior electronics purchases sees relevant reordering without their non-electronics queries degrading.

---

## Block B — Multi-item planning

This is where your example 1 and example 4 finally work end to end.

### T4.7 Composite intent decomposition
MCP tool `plan_purchase(goal, constraints{})`. Handles "plan my trip to Bangalore" or "groceries for palak paneer".

Pipeline:
1. Decompose the goal into required components (flight, hotel — or paneer, spinach, ginger, cream)
2. Search each component independently with inherited constraints
3. Apply cross-component constraints (total budget, date coherence, single-merchant preference for groceries)
4. Return a composed plan with per-item alternatives

Decomposition uses a Claude call — this is the one place an LLM call in the path is justified, because the tool is inherently slow and the buyer expects it to be.

**Acceptance:** "Trip to Bangalore, flight plus hotel under ₹30,000" returns a coherent pair from live adapters with alternatives for each leg.

### T4.8 Recipe and basket composition
For grocery: recipe → ingredient list → quantities → basket from a single merchant where possible, minimising split delivery. Handle substitutions when an ingredient is unavailable.

**Acceptance:** "Groceries for palak paneer for 4" produces a complete basket from one merchant with quantities.

### T4.9 Cross-component constraint solving
Total budget, date coherence (hotel check-in ≥ flight arrival), location coherence (hotel near the stated area). Implement as a constrained selection over the per-component candidate sets, not as prose reasoning.

**Acceptance:** A budget that cannot be satisfied returns a clear explanation of which constraint binds, not a silently over-budget plan.

---

## Block C — Merchant intelligence

### T4.10 Merchant analytics dashboard
- AI impressions: how often their products appeared in results
- Position distribution
- Click-through and conversion by product
- Lost-to-competitor: queries where they appeared but a competitor converted
- Trust score history with component breakdown

**Acceptance:** Merchant can see which of their products get impressions but no clicks — the actionable signal.

### T4.11 "Improve this listing"
For any product, run an AI critique against high-performing listings in the same category. Output concrete actions: missing attributes, weak use-case coverage, poor primary image, uncompetitive delivery promise, price outside the winning band.

**Acceptance:** Applying the suggestions to a low-ranking product measurably improves its position.

### T4.12 Demand signals for merchants
Surface the zero-result clusters relevant to each merchant's categories: "47 buyers searched for X last week and nothing matched." This converts the mining from T4.4 into merchant-facing value and drives catalog expansion.

**Acceptance:** Merchants receive a weekly demand digest scoped to their categories.

---

## Block D — Catalog connectors

Deferred from Phase 1 deliberately. Build these only once catalog quality is proven — a connector that imports 10,000 badly-described products makes search worse, not better.

### T4.13 Shopify connector
OAuth app, webhook-driven sync (`products/create`, `products/update`, `inventory_levels/update`), not polling. Map Shopify variants to `product_variants` directly — the model matches well. Run every imported product through enrichment; Shopify descriptions are marketing copy and need structured metadata added.

Use the GraphQL Bulk Operations API for the initial import to avoid rate limits.

**Acceptance:** A 5,000-product store imports fully, and a stock change in Shopify reflects in search within 60 seconds.

### T4.14 WooCommerce and Unicommerce connectors
Same pattern. Unicommerce matters disproportionately in India for anyone doing real volume.

### T4.15 Generic feed connector
Scheduled pull from a merchant-hosted CSV, XML, or JSON URL. Covers the long tail that has no platform.

---

## Block E — Catalog depth

### T4.16 Image-based attribute extraction
Extract colour, material, pattern, and style from product images and merge into `attributes` where the merchant left them blank. Mark `enrichment_source: 'ai_visual'`.

**Acceptance:** Apparel products with no stated colour get colours extracted with >85% accuracy on a labelled sample.

### T4.17 Bundle and kit support
Products composed of other products, with component-level stock. Needed for gift hampers and grocery kits.

### T4.18 Scheduled price and stock updates
Merchant schedules a price change for a future date; a worker applies it. Must not trigger re-embedding.

---

## Block F — Platform expansion

### T4.19 UCP support
Google's Universal Commerce Protocol for AI Mode and Gemini surfaces. Most retailers will need both ACP-family and UCP to appear across ecosystems. Build as a second adapter over the same catalog — do not fork the data model.

### T4.20 Vector tier management
Move cold merchants and archived products to S3 Vectors; keep the active set in pgvector. Promote on merchant reactivation. Only worth doing past roughly 2 million searchable units.

**Acceptance:** Tiering reduces Aurora storage without measurable latency change on active queries.

### T4.21 Embedding model migration path
When you upgrade the embedding model, you cannot re-embed in place. Build the runbook now:
1. Add `v_semantic_v2` columns
2. Backfill in the background
3. Shadow-score both on live traffic, compare on the golden set
4. Cut over by flag
5. Drop v1 columns after two weeks stable

**Acceptance:** Runbook exists and has been rehearsed once on staging.

---

## Block G — Business sustainability

### T4.22 Merchant tiering
Costs scale with traffic — Bedrock, Aurora, adapter fan-out — and with zero commission, revenue does not. Before scale, introduce tiers: free up to N products and M monthly impressions, paid above. Keep the buyer experience identical across tiers; never let paid placement into ranking, because the moment ranking is purchasable, the trust story that makes this work is gone.

### T4.23 Cost observability
Per-merchant cost attribution: embeddings generated, searches served, adapter calls made. Needed to price the tiers honestly and to spot a merchant whose adapter is burning your Lambda budget.

**Acceptance:** Dashboard shows cost per merchant per month.

---

## Prioritisation guidance

If you can only do three things in Phase 4, do these:

1. **T4.2 — the relevance benchmark.** Everything else is unmeasurable without it.
2. **T4.4 — zero-result mining.** It is simultaneously your ranking fix and your merchant acquisition strategy.
3. **T4.11 — "Improve this listing."** It makes merchants improve their own data, which improves ranking at no engineering cost, and it is the feature that keeps them logging in.

The learned re-ranker is the most technically interesting item here and the third or fourth most valuable. Do not start with it.
