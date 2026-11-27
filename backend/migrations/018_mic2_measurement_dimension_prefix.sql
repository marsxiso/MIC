BEGIN;

ALTER TABLE mic2.measurement_parameters
  ADD COLUMN IF NOT EXISTS dimension_prefix TEXT NOT NULL DEFAULT ''
  CHECK (dimension_prefix IN ('', 'Ø', 'М'));

COMMIT;
