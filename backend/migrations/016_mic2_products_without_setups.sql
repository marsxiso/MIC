BEGIN;

-- Transfer measurement-card ownership from setup records to products.
ALTER TABLE mic2.measurement_cards ADD COLUMN IF NOT EXISTS product_id BIGINT;
UPDATE mic2.measurement_cards mc
SET product_id=ps.product_id
FROM mic2.product_setups ps
WHERE mc.setup_id=ps.id AND mc.product_id IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM mic2.measurement_cards WHERE product_id IS NULL) THEN
    RAISE EXCEPTION 'Cannot migrate measurement cards: product could not be determined';
  END IF;
END $$;

ALTER TABLE mic2.measurement_cards ALTER COLUMN product_id SET NOT NULL;
ALTER TABLE mic2.measurement_cards
  ADD CONSTRAINT measurement_cards_product_id_fkey
  FOREIGN KEY (product_id) REFERENCES mic2.products(id) ON DELETE RESTRICT;

-- Remove every constraint that depends on the obsolete setup_id columns,
-- including the old per-setup version uniqueness constraints.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT c.conrelid::regclass AS table_name, c.conname
    FROM pg_constraint c
    JOIN pg_attribute a
      ON a.attrelid=c.conrelid
     AND a.attnum = ANY(c.conkey)
    WHERE c.conrelid IN ('mic2.measurement_cards'::regclass, 'mic2.production_cycles'::regclass)
      AND a.attname='setup_id'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',r.table_name,r.conname);
  END LOOP;
END $$;

ALTER TABLE mic2.measurement_cards DROP COLUMN setup_id;
ALTER TABLE mic2.production_cycles DROP COLUMN IF EXISTS setup_id;
ALTER TABLE mic2.production_cycles DROP COLUMN IF EXISTS setup_code_snapshot;
ALTER TABLE mic2.qc_round_bins DROP COLUMN IF EXISTS setup_code_snapshot;

ALTER TABLE mic2.measurement_cards
  ADD CONSTRAINT measurement_cards_product_version_key UNIQUE(product_id,version_no);

DROP TABLE IF EXISTS mic2.product_setups;

CREATE INDEX IF NOT EXISTS measurement_cards_product_version_idx
  ON mic2.measurement_cards(product_id, version_no DESC);

COMMIT;
