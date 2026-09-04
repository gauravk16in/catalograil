# Embedding models — verified access

**Not yet verified.** Run `pnpm verify:bedrock` with AWS credentials for the target account;
it overwrites this file with the real answer.

T1.2 exists because D5 is an assumption, not a fact: `cohere.embed-v4` may not be enabled —
or even offered — in `ap-south-1`. Three things downstream depend on the answer:

| If the probe finds                                 | Consequence                                                                                                                                                               |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Embed v4 at 1024 dims, text + image                | D5 holds as written. Build `/packages/embeddings` against it.                                                                                                             |
| Embed v4 only via a cross-region inference profile | Works, but every embedding call leaves the region. Note the added latency in the ingestion budget.                                                                        |
| Only the Titan fallback                            | `amazon.titan-embed-text-v2:0` for `v_semantic`/`v_intent`, `amazon.titan-embed-image-v1` for `v_visual`. Confirm both emit 1024 dims.                                    |
| A dimension other than 1024                        | **Change `vector(1024)` in `searchable_units` before the first migration.** Altering a pgvector column width after HNSW indexes exist means a rebuild of the whole table. |

Until this file is regenerated, treat the model IDs in `.env.example` as unconfirmed.
