-- T1.16 — keep the denormalised filterables on searchable_units current.
--
-- searchable_units is denormalised on purpose so search is one filtered scan with no
-- joins. The cost of that is that price, stock, delivery, merchant status and trust score
-- exist in two places, and the copy is what search actually reads.
--
-- These triggers are the sync. T1.16 recommends triggers over a queue, and the reason is a
-- latency requirement rather than a preference: a merchant setting stock to zero must stop
-- appearing in results within a second, and a queue hop plus a worker cold start cannot
-- promise that. A trigger is inside the same transaction as the change, so by the time the
-- merchant's write commits, search already agrees.
--
-- Note what these deliberately do NOT touch: canonical_text, content_hash, or any vector.
-- Rule 9 says a price change must never cause a re-embed, and a trigger that touched
-- content_hash would silently do exactly that on every repricing.

-- ─── product_variants → searchable_units ────────────────────────────────────────────
--
-- Fires only when a filterable actually changed. Without the WHEN clause every touch of a
-- variant row — including the embedding worker's own writes — would cascade into a
-- searchable_units update and back again.
CREATE OR REPLACE FUNCTION sync_variant_to_searchable_units()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE searchable_units
  SET
    price_paise   = NEW.price_paise,
    in_stock      = (NEW.stock > 0 AND NEW.status = 'active'),
    delivery_days = NEW.delivery_days,
    updated_at    = now()
  WHERE variant_id = NEW.id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER product_variants_sync_searchable
AFTER UPDATE ON product_variants
FOR EACH ROW
WHEN (
  OLD.price_paise   IS DISTINCT FROM NEW.price_paise
  OR OLD.stock      IS DISTINCT FROM NEW.stock
  OR OLD.delivery_days IS DISTINCT FROM NEW.delivery_days
  OR OLD.status     IS DISTINCT FROM NEW.status
)
EXECUTE FUNCTION sync_variant_to_searchable_units();

-- ─── merchants.status → searchable_units ────────────────────────────────────────────
--
-- Rule 15 and never-do #4 both depend on this being immediate: a suspended merchant's
-- entire catalogue has to leave search at once, not when a worker next runs. The search
-- query filters on merchant_status = 'active', so writing the new status here is what
-- removes them.
CREATE OR REPLACE FUNCTION sync_merchant_status_to_searchable_units()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE searchable_units
  SET merchant_status = NEW.status,
      updated_at      = now()
  WHERE merchant_id = NEW.id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER merchants_sync_searchable
AFTER UPDATE ON merchants
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION sync_merchant_status_to_searchable_units();

-- ─── merchant_metrics.trust_score → searchable_units ────────────────────────────────
--
-- Recomputed nightly rather than continuously, so this fires rarely and in bulk. It is a
-- trigger anyway for consistency: one mechanism keeping the denormalised copy true, rather
-- than a trigger for some columns and a worker for others.
CREATE OR REPLACE FUNCTION sync_trust_to_searchable_units()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE searchable_units
  SET trust_score = NEW.trust_score,
      updated_at  = now()
  WHERE merchant_id = NEW.merchant_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER merchant_metrics_sync_searchable
AFTER INSERT OR UPDATE ON merchant_metrics
FOR EACH ROW
WHEN (
  pg_trigger_depth() < 2
  AND NEW.trust_score IS NOT NULL
)
EXECUTE FUNCTION sync_trust_to_searchable_units();

-- ─── products.status → searchable_units ─────────────────────────────────────────────
--
-- Not named in T1.16, but it belongs with the others: an archived product is as invisible
-- as a suspended merchant's, and leaving it out would mean a merchant archiving a listing
-- watched it stay in search until something re-embedded it.
--
-- searchable_units has no product-status column, so this reuses embedding_status — units
-- for an archived product stop being 'indexed' and the search filter drops them. Restoring
-- a product marks them pending, and the embedding worker's hash check makes that cheap:
-- the content has not changed, so it re-indexes without re-embedding.
CREATE OR REPLACE FUNCTION sync_product_status_to_searchable_units()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'archived' THEN
    UPDATE searchable_units
    SET embedding_status = 'pending',
        updated_at       = now()
    WHERE product_id = NEW.id AND embedding_status = 'indexed';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER products_sync_searchable
AFTER UPDATE ON products
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION sync_product_status_to_searchable_units();
