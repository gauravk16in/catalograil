# Relevance baseline — S7.3

**Measured 2026-09-05** against the deployed `dev` environment (`ap-south-1`,
account `149561018240`), over the seeded catalogue: 18 products / 191 variants
across apparel and car accessories, embedded with `global.cohere.embed-v4:0` at
1024 dimensions.

Scored by hand. A result counts as relevant if a buyer who typed that query
would consider it a reasonable answer — not whether it is the *best* answer.

## Result

**37 of 44 top-3 results relevant — 84%**, after deduplicating results by
product. The first measurement was 80%, and the difference is almost entirely
that one product no longer occupies all three slots.

S7.3 sets the Phase 2 gate at 80%. The first run cleared it by nothing at all
while being visibly poor — eleven of fifteen queries returned three variants of
a single product — which is a good illustration of why a score alone is not a
verdict. The fix below is worth more than the four points suggests.

## The queries, after deduplication

| # | Query | Top 3 | Relevant |
| --- | --- | --- | --- |
| 1 | a formal shirt for an office in Chennai | Formal Twill, Oxford, Mandarin Collar | 3/3 |
| 2 | something to record my drive | RoadEye Mini / 4K / Dual-Channel Dashcam | 3/3 |
| 3 | cotton kurta for summer | Cotton Kurta, Khadi Kurta, Linen Shirt | 2/3 |
| 4 | gift for a colleague in the monsoon | Linen Shirt, Solar Panel, Speaker | 2/3 |
| 5 | dashcam with night vision | RoadEye Mini / 4K / Dual-Channel | 3/3 |
| 6 | comfortable trousers for daily wear | Cotton Kurta, Formal Trousers, Chino Trousers | 2/3 |
| 7 | linen shirt under 2500 | Oxford, Printed Resort, **Linen Shirt ₹2,299** | 2/3 |
| 8 | a bag for a weekend trek | Charger, Speaker, Cargo Trousers | **0/3** |
| 9 | kurta with chikankari work | Chikankari, Cotton, Silk Blend Festive Kurta | 3/3 |
| 10 | something to keep my car safe | Mini Dashcam, 4K Dashcam, Seat Organiser | 3/3 |
| 11 | white shirt for a wedding | Oxford, Formal Twill, Mandarin Collar | 3/3 |
| 12 | breathable fabric for humid weather | Linen, Seersucker, Printed Resort Shirt | 3/3 |
| 13 | 4k camera for my car | Mini Dashcam, 4K Dashcam, Rear Camera Add-on | 3/3 |
| 14 | traditional wear for a festival | Chikankari, Silk Blend Festive, Cotton Kurta | 3/3 |
| 15 | smart casual trousers | Formal Trousers, Chino Trousers (2 results) | 2/2 |

Query 2 is the one worth noting positively: "record my drive" shares no word with
"dashcam", so that match is entirely semantic. It is the premise of the product
working.

## What is actually wrong

### 1. One product occupying every slot — fixed

Eleven of the fifteen queries originally returned three variants of a *single*
product. D6 makes the variant the retrieval unit, which is right — a buyer asking
for size 42 should match the size-42 row — but it is wrong for presentation: a
buyer saw the same shirt three times and concluded the catalogue was empty.

It did not show up in the first score at all, because each of those results *is*
relevant. It would have shown up immediately in a buyer's face, and it mattered
most at the MCP surface, where rule 6 allows five results total and one shirt
could spend all five.

Results are now deduplicated by `product_id` **after** reranking, so the variant
that survives is the one that actually scored best rather than whichever the
query happened to return first. Two queries improved outright: query 6 went from
0/3 to 2/3, and query 7 now surfaces the linen shirt it was hiding.

### 2. A category confusion — query 6, improved but not solved

"comfortable trousers for daily wear" still leads with a kurta, though real
trousers now take the other two slots. The intent channel matches "comfortable /
daily wear" strongly enough to outrank the garment type, and nothing in the
pipeline treats "trousers" as a hard category signal.

This is the failure most likely to embarrass the product, because the top answer
is confidently the wrong *kind* of thing. It is a ranking problem — the right fix
is a category-agreement term in the rerank, which is Phase 4 territory.

### 3. An attribute the buyer named ranks third — query 7

"linen shirt under 2500" now returns Meridian Linen Shirt at ₹2,299, but at
position three behind two non-linen shirts. The price wording is correctly
ignored — parsing "under 2500" into a filter is the calling model's job under
rule 10 — but "linen" is in the enriched attributes and still does not win.

### 4. Query 8 is arguably not a failure

There is no bag in the seeded catalogue. The honest answer is "nothing here
matches", and instead it returned a charger, a speaker and cargo trousers. Rule 8
exists for exactly this, and the relevance floor should have produced a
`no_results_reason`. That it did not means the floor is too low for a catalogue
this small, or the lexical channel is rescuing weak matches — worth investigating
alongside fix 1.

## Method, so this can be repeated

```bash
# Against a deployed environment, with a merchant JWT:
curl -s -X POST "$API_BASE_URL/merchant/search-preview" \
  -H "Authorization: Bearer $ID_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"query":"<query>","limit":3}'
```

The fifteen queries above are in `e2e/fixtures/relevance-queries.txt`. Re-score
by hand after any ranking change and append a dated row below — a baseline whose
history is overwritten cannot show whether a change helped.

## History

| Date | Catalogue | Top-3 relevance | Note |
| --- | --- | --- | --- |
| 2026-09-05 | 18 products / 191 variants | 80% | First measurement. Gate met marginally, and visibly poor: 11 of 15 queries returned one product three times. |
| 2026-09-05 | 18 products / 191 variants | 84% | After deduplicating by product. Queries 6 and 7 improved outright; every query now returns distinct products. |
