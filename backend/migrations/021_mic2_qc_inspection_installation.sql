BEGIN;
ALTER TABLE mic2.qc_inspections
  ADD COLUMN IF NOT EXISTS installation_no INTEGER;
COMMIT;
