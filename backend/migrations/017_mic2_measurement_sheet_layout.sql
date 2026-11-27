BEGIN;

ALTER TABLE mic2.measurement_parameters
  ADD COLUMN IF NOT EXISTS installation_no INTEGER NOT NULL DEFAULT 1
    CHECK (installation_no > 0),
  ADD COLUMN IF NOT EXISTS drawing_dimension TEXT,
  ADD COLUMN IF NOT EXISTS upper_deviation TEXT,
  ADD COLUMN IF NOT EXISTS lower_deviation TEXT;

-- Preserve existing cards as a single-installation sheet and keep their
-- previous nominal/tolerance values available to older inspection records.
UPDATE mic2.measurement_parameters
SET drawing_dimension = COALESCE(NULLIF(drawing_dimension,''), NULLIF(nominal_value,''))
WHERE drawing_dimension IS NULL OR drawing_dimension='';

CREATE INDEX IF NOT EXISTS measurement_parameters_card_installation_idx
  ON mic2.measurement_parameters(card_id, installation_no, sort_order);

COMMIT;
