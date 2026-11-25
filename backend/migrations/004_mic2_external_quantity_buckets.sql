-- MIC 2.0 quantity ledger extension
-- Distinguishes pieces physically removed from the plastic bin into rework
-- or isolator from pieces still physically inside the bin.
-- Apply after migrations 001-003.

BEGIN;

ALTER TABLE mic2.cycle_quantity_movements
  DROP CONSTRAINT cycle_quantity_movements_from_bucket_check,
  DROP CONSTRAINT cycle_quantity_movements_to_bucket_check;

ALTER TABLE mic2.cycle_quantity_movements
  ADD CONSTRAINT cycle_quantity_movements_from_bucket_check
  CHECK (from_bucket IN (
    'production_pending_qc',
    'good_unboxed',
    'rework',
    'rework_pending_qc',
    'isolator',
    'rework_external',
    'isolator_external'
  ));

ALTER TABLE mic2.cycle_quantity_movements
  ADD CONSTRAINT cycle_quantity_movements_to_bucket_check
  CHECK (to_bucket IN (
    'production_pending_qc',
    'good_unboxed',
    'rework',
    'rework_pending_qc',
    'isolator',
    'rework_external',
    'isolator_external',
    'packed',
    'scrapped'
  ));

CREATE OR REPLACE VIEW mic2.v_cycle_quantity_balances AS
SELECT
  c.id AS cycle_id,
  b.bucket,
  COALESCE(SUM(
    CASE WHEN m.to_bucket = b.bucket THEN m.quantity ELSE 0 END
    -
    CASE WHEN m.from_bucket = b.bucket THEN m.quantity ELSE 0 END
  ), 0)::BIGINT AS quantity
FROM mic2.production_cycles c
CROSS JOIN (
  VALUES
    ('production_pending_qc'::TEXT),
    ('good_unboxed'::TEXT),
    ('rework'::TEXT),
    ('rework_pending_qc'::TEXT),
    ('isolator'::TEXT),
    ('rework_external'::TEXT),
    ('isolator_external'::TEXT),
    ('packed'::TEXT),
    ('scrapped'::TEXT)
) AS b(bucket)
LEFT JOIN mic2.cycle_quantity_movements m ON m.cycle_id = c.id
GROUP BY c.id, b.bucket;

CREATE OR REPLACE FUNCTION mic2.assert_bin_can_be_freed()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_latest_cycle BIGINT;
  v_cycle_status TEXT;
  v_remaining BIGINT;
BEGIN
  IF NEW.bin_status = 'free' AND OLD.bin_status <> 'free' THEN
    SELECT id, cycle_status
      INTO v_latest_cycle, v_cycle_status
    FROM mic2.production_cycles
    WHERE bin_id = NEW.id
    ORDER BY cycle_no DESC
    LIMIT 1;

    IF v_latest_cycle IS NOT NULL THEN
      IF v_cycle_status <> 'completed' THEN
        RAISE EXCEPTION 'Bin % cannot be freed before its production cycle is completed', NEW.id;
      END IF;

      SELECT COALESCE(SUM(quantity), 0)
        INTO v_remaining
      FROM mic2.v_cycle_quantity_balances
      WHERE cycle_id = v_latest_cycle
        AND bucket NOT IN (
          'rework_external',
          'isolator_external',
          'packed',
          'scrapped'
        );

      IF v_remaining <> 0 THEN
        RAISE EXCEPTION
          'Bin % still contains % unaccounted or unremoved pieces',
          NEW.id, v_remaining;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMIT;
