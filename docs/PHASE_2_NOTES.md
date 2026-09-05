# Phase 2 — findings worth carrying forward

## Attribute keys are not normalised, and it degrades `compare_products`

Comparing three RoadEye dashcams through the MCP tool returns fifteen attribute keys, and
**every one of them appears in the `differences` list**:

```
cable_length_metres   cable_metres
wifi                  wifi_enabled
compatible_models     compatible_with
```

Those are three pairs of the same attribute under different names. The enrichment model
(T1.13) invents a key per product rather than reusing one across a category, so two products
that genuinely agree about having Wi-Fi look like they disagree — each has a key the other
lacks, so both read as differences with a `null` on the other side.

T2.4's acceptance passes: the rows align, the nulls are explicit, and the differences list is
computed correctly. The output is still much less useful than it looks, because the one
signal it exists to provide — *what actually differs* — is swamped by keys that differ only
in spelling.

**This is a data problem, not a comparison problem**, so the fix belongs in enrichment:
`categories.attribute_schema` already exists in the schema for exactly this and is unused.
Passing the category's known keys into the enrichment prompt, and preferring an existing key
over a new one, would collapse most of these pairs. Until then, do not read the size of a
`differences` list as a measure of how different two products are.

Recorded rather than fixed because it is a ranking-quality problem of the kind Phase 4 is
for, and because fixing it means re-enriching a catalogue rather than changing a query.

## The MCP SDK's tool registry is not public API

`server.tool()` records into `_registeredTools`, and the entry's callback field is `handler`.
It is not documented, and a deployed call failed with `n.callback is not a function` until it
was found by inspecting a built server. An SDK upgrade can move it again and the symptom will
only appear at runtime, so `services/mcp/src/handler.ts` carries a note where it reaches in.

The alternative — the SDK's own transports — assumes a long-lived server bound to a
request/response stream, which a Lambda does not have.

## Search returns two ids, and the tools chain on different ones

D6 makes the *variant* the searchable unit, so `search_products` returns it as `id`. But
`get_product` and `compare_products` take a *product* id, and a model has no way to derive
one from the other. Returning only `id` made every `get_product` call after a search fail on
a UUID that was real but was not a product.

Both are returned now, and each tool's parameter description says which it wants. Worth
remembering when adding a tool: the id a model has is whichever the last tool gave it.

## `sql<Date>` is an assertion, not a conversion

Drizzle's `sql<Date>\`MAX(updated_at)\`` types the column as a `Date` and hands back a
string. This has now caused two failures whose symptom — `toISOString is not a function` —
appeared several layers from the query that produced it. `toDate()` in `@catalograil/core`
now does the coercion at the boundary; use it for any timestamp that arrives through raw SQL.
