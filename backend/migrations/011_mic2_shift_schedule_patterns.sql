BEGIN;

CREATE TABLE mic2.shift_schedule_patterns (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_id BIGINT NOT NULL REFERENCES mic2.employees(id) ON DELETE RESTRICT,
  pattern_code TEXT NOT NULL CHECK (pattern_code IN ('3x3','5x2')),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT REFERENCES mic2.employees(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  replaced_at TIMESTAMPTZ,
  replaced_by BIGINT REFERENCES mic2.employees(id) ON DELETE SET NULL,
  notes TEXT,
  CHECK (end_date > start_date)
);

CREATE UNIQUE INDEX shift_schedule_patterns_one_active_per_employee
  ON mic2.shift_schedule_patterns(employee_id)
  WHERE is_active;

ALTER TABLE mic2.shift_assignments
  ADD COLUMN schedule_pattern_id BIGINT
  REFERENCES mic2.shift_schedule_patterns(id) ON DELETE SET NULL;

CREATE INDEX shift_assignments_pattern_date_idx
  ON mic2.shift_assignments(schedule_pattern_id, shift_date)
  WHERE schedule_pattern_id IS NOT NULL;

COMMIT;
