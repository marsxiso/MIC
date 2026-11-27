BEGIN;

-- Move measurement-card ownership from the obsolete setup record to the product.
ALTER TABLE mic2.measurement_cards ADD COLUMN IF NOT EXISTS product_id BIGINT;
UPDATE mic2.measurement_cards mc
SET product_id=ps.product_id
FROM mic2.product_setups ps
WHERE mc.setup_id=ps.id AND mc.product_id IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM mic2.measurement_cards WHERE product_id IS NULL) THEN
    RAISE EXCEPTION 'Cannot migrate measurement cards: a setup has no product';
  END IF;
END $$;

ALTER TABLE mic2.measurement_cards ALTER COLUMN product_id SET NOT NULL;
ALTER TABLE mic2.measurement_cards
  ADD CONSTRAINT measurement_cards_product_id_fkey
  FOREIGN KEY (product_id) REFERENCES mic2.products(id) ON DELETE RESTRICT;

ALTER TABLE mic2.measurement_cards DROP CONSTRAINT IF EXISTS measurement_cards_setup_id_fkey;
ALTER TABLE mic2.measurement_cards DROP COLUMN setup_id;

ALTER TABLE mic2.production_cycles DROP CONSTRAINT IF EXISTS production_cycles_setup_id_product_id_fkey;
ALTER TABLE mic2.production_cycles DROP CONSTRAINT IF EXISTS production_cycles_setup_id_fkey;
ALTER TABLE mic2.production_cycles DROP COLUMN IF EXISTS setup_id;
ALTER TABLE mic2.production_cycles DROP COLUMN IF EXISTS setup_code_snapshot;

ALTER TABLE mic2.qc_round_bins DROP COLUMN IF EXISTS setup_code_snapshot;

DROP TABLE IF EXISTS mic2.product_setups;

CREATE INDEX IF NOT EXISTS measurement_cards_product_version_idx
  ON mic2.measurement_cards(product_id, version_no DESC);

COMMIT;
