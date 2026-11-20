-- MIC 2.0 integrity layer
-- Adds database-level consistency checks to the isolated mic2 schema.
-- Apply only after 001_mic2_foundation.sql, on a dedicated test database.

BEGIN;

-- A production cycle may only use a measurement card belonging to its selected setup.
ALTER TABLE mic2.measurement_cards
  ADD CONSTRAINT measurement_cards_id_setup_uk UNIQUE (id, setup_id);

ALTER TABLE mic2.production_cycles
  ADD CONSTRAINT production_cycles_card_setup_fk
  FOREIGN KEY (card_id, setup_id)
  REFERENCES mic2.measurement_cards (id, setup_id)
  ON DELETE RESTRICT;

-- A single operator report can create at most one official defect record.
CREATE UNIQUE INDEX defects_one_per_source_report
  ON mic2.defects(source_report_id)
  WHERE source_report_id IS NOT NULL;

-- A superseded decision must belong to the same defect as the new decision.
ALTER TABLE mic2.defect_decisions
  ADD CONSTRAINT defect_decisions_id_defect_uk UNIQUE (id, defect_id);

ALTER TABLE mic2.defect_decisions
  ADD CONSTRAINT defect_decisions_superseded_same_defect_fk
  FOREIGN KEY (supersedes_decision_id, defect_id)
  REFERENCES mic2.defect_decisions (id, defect_id)
  ON DELETE RESTRICT;

-- Do not allow a cycle to be marked active after it has already been ended.
ALTER TABLE mic2.production_cycles
  ADD CONSTRAINT production_cycles_status_end_consistency_ck
  CHECK (
    (cycle_status = 'active' AND ended_at IS NULL)
    OR
    (cycle_status IN ('completed', 'cancelled') AND ended_at IS NOT NULL)
  );

-- Do not allow an archived plastic bin to be used for a new active cycle.
CREATE OR REPLACE FUNCTION mic2.check_cycle_bin_is_usable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_bin_status TEXT;
BEGIN
  SELECT bin_status INTO v_bin_status
  FROM mic2.plastic_bins
  WHERE id = NEW.bin_id
  FOR UPDATE;

  IF v_bin_status IS NULL THEN
    RAISE EXCEPTION 'Plastic bin % does not exist', NEW.bin_id;
  END IF;

  IF NEW.cycle_status = 'active' AND v_bin_status = 'archived' THEN
    RAISE EXCEPTION 'Archived plastic bin % cannot start a cycle', NEW.bin_id;
  END IF;

  IF TG_OP = 'INSERT' AND NEW.cycle_status = 'active' AND v_bin_status <> 'free' THEN
    RAISE EXCEPTION 'Plastic bin % is not free', NEW.bin_id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER production_cycles_check_bin
BEFORE INSERT OR UPDATE OF bin_id, cycle_status
ON mic2.production_cycles
FOR EACH ROW
EXECUTE FUNCTION mic2.check_cycle_bin_is_usable();

-- Finished box quantity is maintained only by its append-only additions.
CREATE OR REPLACE FUNCTION mic2.guard_finished_box_quantity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.quantity IS DISTINCT FROM OLD.quantity AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'Finished box quantity is calculated from finished_box_additions';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER finished_boxes_quantity_guard
BEFORE UPDATE OF quantity
ON mic2.finished_boxes
FOR EACH ROW
EXECUTE FUNCTION mic2.guard_finished_box_quantity();

CREATE OR REPLACE FUNCTION mic2.add_finished_box_quantity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_quantity INTEGER;
  v_norm INTEGER;
  v_closed_at TIMESTAMPTZ;
BEGIN
  SELECT quantity, box_norm_snapshot, closed_at
    INTO v_quantity, v_norm, v_closed_at
  FROM mic2.finished_boxes
  WHERE id = NEW.box_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Finished box % does not exist', NEW.box_id;
  END IF;

  IF v_closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Finished box % is closed and cannot accept additions', NEW.box_id;
  END IF;

  IF v_quantity + NEW.quantity > v_norm THEN
    RAISE EXCEPTION
      'Box capacity exceeded: current %, addition %, norm %',
      v_quantity, NEW.quantity, v_norm;
  END IF;

  UPDATE mic2.finished_boxes
  SET quantity = quantity + NEW.quantity
  WHERE id = NEW.box_id;

  RETURN NEW;
END;
$$;

CREATE TRIGGER finished_box_additions_apply
BEFORE INSERT
ON mic2.finished_box_additions
FOR EACH ROW
EXECUTE FUNCTION mic2.add_finished_box_quantity();

-- Additions are a historical ledger: correct them with a compensating entry,
-- never by rewriting or deleting the original row.
CREATE OR REPLACE FUNCTION mic2.prevent_finished_box_addition_rewrite()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Finished box additions are append-only; record a correction instead';
END;
$$;

CREATE TRIGGER finished_box_additions_no_update
BEFORE UPDATE OR DELETE
ON mic2.finished_box_additions
FOR EACH ROW
EXECUTE FUNCTION mic2.prevent_finished_box_addition_rewrite();

-- A closed box may never be reopened.
CREATE OR REPLACE FUNCTION mic2.prevent_finished_box_reopen()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.closed_at IS NOT NULL AND NEW.closed_at IS NULL THEN
    RAISE EXCEPTION 'A closed finished box cannot be reopened';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER finished_boxes_no_reopen
BEFORE UPDATE OF closed_at
ON mic2.finished_boxes
FOR EACH ROW
EXECUTE FUNCTION mic2.prevent_finished_box_reopen();

-- Starting a cycle occupies the bin. Completing a cycle deliberately does NOT
-- free it: QC must account for and physically clear all contents first.
CREATE OR REPLACE FUNCTION mic2.occupy_bin_on_cycle_start()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.cycle_status = 'active' THEN
    UPDATE mic2.plastic_bins
    SET bin_status = 'occupied'
    WHERE id = NEW.bin_id AND bin_status = 'free';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Plastic bin % is not available for a new cycle', NEW.bin_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER production_cycles_occupy_bin
AFTER INSERT
ON mic2.production_cycles
FOR EACH ROW
EXECUTE FUNCTION mic2.occupy_bin_on_cycle_start();

-- A bin can only be marked free if it has no active production cycle.
CREATE OR REPLACE FUNCTION mic2.guard_plastic_bin_status()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.bin_status = 'free' AND EXISTS (
    SELECT 1 FROM mic2.production_cycles
    WHERE bin_id = NEW.id AND cycle_status = 'active'
  ) THEN
    RAISE EXCEPTION 'Plastic bin % still has an active production cycle', NEW.id;
  END IF;

  IF NEW.bin_status = 'archived' AND EXISTS (
    SELECT 1 FROM mic2.production_cycles
    WHERE bin_id = NEW.id AND cycle_status = 'active'
  ) THEN
    RAISE EXCEPTION 'Plastic bin % cannot be archived while a cycle is active', NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER plastic_bins_status_guard
BEFORE UPDATE OF bin_status
ON mic2.plastic_bins
FOR EACH ROW
EXECUTE FUNCTION mic2.guard_plastic_bin_status();

COMMIT;
