BEGIN;

ALTER TABLE mic2.shift_assignments
  DROP CONSTRAINT IF EXISTS shift_assignments_attendance_status_check;

ALTER TABLE mic2.shift_assignments
  ADD CONSTRAINT shift_assignments_attendance_status_check
  CHECK (attendance_status IN ('pending','present','absent','replaced','left_early'));

ALTER TABLE mic2.shift_assignments
  ADD COLUMN IF NOT EXISTS attendance_note TEXT;

CREATE INDEX IF NOT EXISTS shift_assignments_qc_calendar_idx
  ON mic2.shift_assignments(shift_date,employee_id);

COMMIT;
