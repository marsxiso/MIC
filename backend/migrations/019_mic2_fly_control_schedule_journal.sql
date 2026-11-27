BEGIN;

CREATE TABLE IF NOT EXISTS mic2.qc_fly_control_schedule_events (
  id BIGSERIAL PRIMARY KEY,
  cycle_id BIGINT NOT NULL REFERENCES mic2.production_cycles(id) ON DELETE RESTRICT,
  scheduled_for TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','completed','missed')),
  completed_inspection_id BIGINT NULL REFERENCES mic2.qc_inspections(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cycle_id, scheduled_for),
  CHECK (window_end > scheduled_for)
);

CREATE INDEX IF NOT EXISTS qc_fly_schedule_status_idx
  ON mic2.qc_fly_control_schedule_events(status, scheduled_for);

CREATE TABLE IF NOT EXISTS mic2.qc_fly_control_journal (
  id BIGSERIAL PRIMARY KEY,
  schedule_event_id BIGINT NOT NULL REFERENCES mic2.qc_fly_control_schedule_events(id) ON DELETE RESTRICT,
  actor_id BIGINT NULL REFERENCES mic2.employees(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (action IN ('scheduled','completed','missed','edited')),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS qc_fly_journal_event_idx
  ON mic2.qc_fly_control_journal(schedule_event_id, created_at);

COMMIT;
