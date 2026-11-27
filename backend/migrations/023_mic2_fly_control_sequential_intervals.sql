BEGIN;

-- Future intervals are planned, not actionable. Only the current sequential interval is pending.
ALTER TABLE mic2.qc_fly_control_schedule_events
  DROP CONSTRAINT IF EXISTS qc_fly_control_schedule_events_status_check;

ALTER TABLE mic2.qc_fly_control_schedule_events
  ADD CONSTRAINT qc_fly_control_schedule_events_status_check
  CHECK (status IN ('scheduled','pending','completed','missed'));

ALTER TABLE mic2.qc_fly_control_schedule_events
  ALTER COLUMN status SET DEFAULT 'scheduled';

UPDATE mic2.qc_fly_control_schedule_events
SET status='scheduled',updated_at=now()
WHERE status='pending' AND scheduled_for>now();

COMMIT;
