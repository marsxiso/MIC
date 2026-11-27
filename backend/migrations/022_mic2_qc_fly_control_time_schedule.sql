BEGIN;
ALTER TABLE mic2.qc_fly_control_events
  ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ;
COMMIT;
