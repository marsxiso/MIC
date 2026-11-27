BEGIN;

ALTER TABLE mic2.shift_schedule_patterns
  DROP CONSTRAINT IF EXISTS shift_schedule_patterns_pattern_code_check;

ALTER TABLE mic2.shift_schedule_patterns
  ADD CONSTRAINT shift_schedule_patterns_pattern_code_check
  CHECK (pattern_code IN ('3x3', '5x2', '2x2x4'));

COMMIT;
