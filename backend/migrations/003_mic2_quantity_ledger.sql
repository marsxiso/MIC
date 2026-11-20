-- MIC 2.0 quantity ledger
-- One immutable movement ledger is the source of truth for physical quantities
-- within a production cycle. Apply after migrations 001 and 002.
-- Apply only to a dedicated local/test database until the application is wired to it.

BEGIN;

CREATE TABLE mic2.cycle_quantity_movements (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cycle_id BIGINT NOT NULL REFERENCES mic2.production_cycles(id) ON DELETE RESTRICT,
  movement_type TEXT NOT NULL CHECK (movement_type IN (
    'production_received',
    'qc_good',
    'qc_to_rework',
    'qc_to_isolator',
    'rework_sent',
    'rework_returned',
    'isolator_returned',
    'packed',
    'scrapped',
    'manual_correction'
  )),
  from_bucket TEXT CHECK (from_bucket IN (
    'production_pending_qc',
    'good_unboxed',
    'rework',
    'rework_pending_qc',
    'isolator'
  )),
  to_bucket TEXT CHECK (to_bucket IN (
    'production_pending_qc',
    'good_unboxed',
    'rework',
    'rework_pending_qc',
    'isolator',
    'packed',
    'scrapped'
  )),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  defect_id BIGINT REFERENCES mic2.defects(id) ON DELETE RESTRICT,
  related_movement_id BIGINT REFERENCES mic2.cycle_quantity_movements(id) ON DELETE RESTRICT,
  entered_by BIGINT NOT NULL REFERENCES mic2.employees(id) ON DELETE RESTRICT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  note TEXT,
  CHECK (from_bucket IS NOT NULL OR to_bucket IS NOT NULL),
  CHECK (from_bucket IS DISTINCT FROM to_bucket)
);

CREATE INDEX cycle_quantity_movements_cycle_idx
  ON mic2.cycle_quantity_movements(cycle_id, occurred_at, id);

CREATE INDEX cycle_quantity_movements_defect_idx
  ON mic2.cycle_quantity_movements(defect_id, occurred_at)
  WHERE defect_id IS NOT NULL;

-- Lock the cycle while validating and posting a movement. This serializes
-- competing transactions for the same cycle and prevents negative balances.
CREATE OR REPLACE FUNCTION mic2.validate_cycle_quantity_movement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_balance BIGINT;
BEGIN
  PERFORM 1
  FROM mic2.production_cycles
  WHERE id = NEW.cycle_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Production cycle % does not exist', NEW.cycle_id;
  END IF;

  IF NEW.from_bucket IS NOT NULL THEN
    SELECT COALESCE(SUM(
      CASE WHEN to_bucket = NEW.from_bucket THEN quantity ELSE 0 END
      -
      CASE WHEN from_bucket = NEW.from_bucket THEN quantity ELSE 0 END
    ), 0)
    INTO v_balance
    FROM mic2.cycle_quantity_movements
    WHERE cycle_id = NEW.cycle_id;

    IF v_balance < NEW.quantity THEN
      RAISE EXCEPTION
        'Insufficient quantity in bucket % for cycle %: available %, requested %',
        NEW.from_bucket, NEW.cycle_id, v_balance, NEW.quantity;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER cycle_quantity_movement_validate
BEFORE INSERT
ON mic2.cycle_quantity_movements
FOR EACH ROW
EXECUTE FUNCTION mic2.validate_cycle_quantity_movement();

-- Movement history is immutable. Corrections are compensating movements.
CREATE OR REPLACE FUNCTION mic2.prevent_cycle_quantity_movement_rewrite()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Quantity movements are append-only; post a correcting movement instead';
END;
$$;

CREATE TRIGGER cycle_quantity_movements_no_rewrite
BEFORE UPDATE OR DELETE
ON mic2.cycle_quantity_movements
FOR EACH ROW
EXECUTE FUNCTION mic2.prevent_cycle_quantity_movement_rewrite();

-- A cycle's current quantity by bucket can be queried from this view.
CREATE VIEW mic2.v_cycle_quantity_balances AS
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
    ('packed'::TEXT),
    ('scrapped'::TEXT)
) AS b(bucket)
LEFT JOIN mic2.cycle_quantity_movements m ON m.cycle_id = c.id
GROUP BY c.id, b.bucket;

-- A cycle may be completed while pieces remain in QC/rework/isolator.
-- The bin can be freed only after the cycle is completed and every physical
-- piece has left the reusable plastic bin. Packed and scrapped pieces count
-- as removed; all other buckets mean pieces remain to be dealt with.
CREATE OR REPLACE FUNCTION mic2.assert_bin_can_be_freed()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_active_cycle BIGINT;
  v_cycle_status TEXT;
  v_remaining BIGINT;
BEGIN
  IF NEW.bin_status = 'free' AND OLD.bin_status <> 'free' THEN
    SELECT id, cycle_status
      INTO v_active_cycle, v_cycle_status
    FROM mic2.production_cycles
    WHERE bin_id = NEW.id
    ORDER BY cycle_no DESC
    LIMIT 1;

    IF v_active_cycle IS NOT NULL THEN
      IF v_cycle_status <> 'completed' THEN
        RAISE EXCEPTION 'Bin % cannot be freed before its production cycle is completed', NEW.id;
      END IF;

      SELECT COALESCE(SUM(quantity), 0)
        INTO v_remaining
      FROM mic2.v_cycle_quantity_balances
      WHERE cycle_id = v_active_cycle
        AND bucket NOT IN ('packed', 'scrapped');

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

CREATE TRIGGER plastic_bins_free_requires_clearance
BEFORE UPDATE OF bin_status
ON mic2.plastic_bins
FOR EACH ROW
EXECUTE FUNCTION mic2.assert_bin_can_be_freed();

COMMIT;
