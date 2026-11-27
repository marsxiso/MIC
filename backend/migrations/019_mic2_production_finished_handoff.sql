BEGIN;
ALTER TABLE mic2.production_cycles
  ADD COLUMN IF NOT EXISTS production_finished_at TIMESTAMPTZ;
COMMIT;
