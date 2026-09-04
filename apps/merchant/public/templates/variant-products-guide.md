# Variant products — CSV guide

One row per **variant**. Rows sharing an `external_ref` collapse into one product with several options — that is the part most people get wrong, so the sample file shows three rows becoming one three-option product.

## Columns

| Column | Required | Notes |
| --- | --- | --- |
| `external_ref` | Yes | Your own product code. Re-importing the same value updates that product instead of creating a second one. For a variant product, every row of the same product shares this. |
| `name` | Yes | What a buyer would call it. Not a SKU. |
| `brand` | No | Leave blank if unbranded. |
| `description` | No | Plain sentences. This is the main thing search matches against, so describe what it is for, not just what it is. |
| `category_hint` | No | A rough category if you have one, e.g. "running shoes". We refine it automatically. |
| `option_axis_1_name` | Yes | What varies, e.g. "size". Up to three axes; use axes 2 and 3 only if you need them. |
| `option_axis_1_value` | Yes | This row’s value on that axis, e.g. "42". |
| `option_axis_2_name` | No | Second axis, e.g. "colour". |
| `option_axis_2_value` | No | Required if axis 2 is named. |
| `option_axis_3_name` | No | Third axis, e.g. "fabric". |
| `option_axis_3_value` | No | Required if axis 3 is named. |
| `sku` | Yes | Unique within the product. This is what gets ordered. |
| `price` | Yes | Rupees, e.g. 1899 or 1899.50. No symbols, no commas. |
| `mrp` | No | Rupees. Must be at least the price if given. |
| `stock` | Yes | Whole number. 0 hides it from search until restocked. |
| `delivery_days` | No | Typical days to deliver. Buyers filter on this, and an item that cannot arrive in time is excluded rather than ranked lower — so an honest number wins more orders than an optimistic one. |
| `image_url_1` | Yes | Publicly reachable https URL. We fetch it once. |
| `image_url_2` | No | Optional. |
| `image_url_3` | No | Optional. |

## Rules worth knowing before you upload

- Headers must match exactly, in any order. A mismatch rejects the whole file rather than importing half of it.
- Money is in rupees, written plainly: `1899` or `1899.50`. No `₹`, no thousands separators.
- Re-importing a row with an `external_ref` you have used before **updates** that product. It never creates a duplicate.
- Changing only price or stock does not re-run indexing, so those updates appear in search within seconds.
- Nothing appears in search until it has been enriched and indexed. The Products page shows where each one is.
