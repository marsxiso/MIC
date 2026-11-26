BEGIN;

ALTER TABLE mic2.shift_assignments
  ADD COLUMN IF NOT EXISTS actual_start_time TIME,
  ADD COLUMN IF NOT EXISTS actual_end_time TIME;

COMMIT;
