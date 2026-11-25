BEGIN;

-- Give every plastic bin a stable human-readable code.
ALTER TABLE mic2.plastic_bins
  ADD COLUMN bin_code TEXT;

UPDATE mic2.plastic_bins
SET bin_code = LPAD(id::TEXT, 2, '0')
WHERE bin_code IS NULL;

ALTER TABLE mic2.plastic_bins
  ALTER COLUMN bin_code SET NOT NULL;

ALTER TABLE mic2.plastic_bins
  ADD CONSTRAINT plastic_bins_bin_code_format_ck
    CHECK (bin_code ~ '^[0-9]{2,}$');

CREATE UNIQUE INDEX plastic_bins_bin_code_uidx
  ON mic2.plastic_bins (bin_code);

-- Link every new finished-box addition to its source production cycle.
ALTER TABLE mic2.finished_box_additions
  ADD COLUMN source_cycle_id BIGINT;

ALTER TABLE mic2.finished_box_additions
  ADD CONSTRAINT finished_box_additions_source_cycle_id_fkey
  FOREIGN KEY (source_cycle_id)
  REFERENCES mic2.production_cycles(id)
  ON DELETE RESTRICT;

CREATE INDEX finished_box_additions_source_cycle_idx
  ON mic2.finished_box_additions (source_cycle_id);

-- Historical rows may predate source-cycle tracking. New rows must provide it.
ALTER TABLE mic2.finished_box_additions
  ADD CONSTRAINT finished_box_additions_source_cycle_required_ck
  CHECK (source_cycle_id IS NOT NULL) NOT VALID;

CREATE OR REPLACE FUNCTION mic2.validate_finished_box_addition_source()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  v_box_product_id BIGINT;
  v_cycle_product_id BIGINT;
BEGIN
  IF NEW.source_cycle_id IS NULL THEN
    RAISE EXCEPTION 'A source production cycle is required when packing a finished box';
  END IF;

  SELECT product_id INTO v_box_product_id
  FROM mic2.finished_boxes
  WHERE id = NEW.box_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Finished box % does not exist', NEW.box_id;
  END IF;

  SELECT product_id INTO v_cycle_product_id
  FROM mic2.production_cycles
  WHERE id = NEW.source_cycle_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Source production cycle % does not exist', NEW.source_cycle_id;
  END IF;

  IF v_box_product_id <> v_cycle_product_id THEN
    RAISE EXCEPTION 'A finished box can contain only its own product';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION mic2.post_finished_box_quantity_movement()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO mic2.cycle_quantity_movements (
    cycle_id, movement_type, from_bucket, to_bucket,
    quantity, entered_by, occurred_at, note
  )
  VALUES (
    NEW.source_cycle_id, 'packed', 'good_unboxed', 'packed',
    NEW.quantity, NEW.added_by, NEW.added_at,
    COALESCE(NEW.note, 'Finished-box addition ' || NEW.id::TEXT)
  );

  RETURN NEW;
END;
$function$;

CREATE TRIGGER finished_box_additions_validate_source
BEFORE INSERT ON mic2.finished_box_additions
FOR EACH ROW
EXECUTE FUNCTION mic2.validate_finished_box_addition_source();

CREATE TRIGGER finished_box_additions_post_quantity
AFTER INSERT ON mic2.finished_box_additions
FOR EACH ROW
EXECUTE FUNCTION mic2.post_finished_box_quantity_movement();

COMMIT;
