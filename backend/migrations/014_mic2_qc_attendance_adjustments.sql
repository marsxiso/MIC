BEGIN;
ALTER TABLE mic2.shift_assignments
  ADD COLUMN IF NOT EXISTS attendance_adjusted_by BIGINT REFERENCES mic2.employees(id),
  ADD COLUMN IF NOT EXISTS attendance_adjusted_at TIMESTAMPTZ;
COMMIT;
