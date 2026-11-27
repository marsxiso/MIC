BEGIN;
CREATE TABLE IF NOT EXISTS mic2.qc_control_schedules (
  product_id BIGINT PRIMARY KEY REFERENCES mic2.products(id) ON DELETE RESTRICT,
  first_piece_required BOOLEAN NOT NULL DEFAULT TRUE,
  fly_interval_quantity INTEGER NOT NULL DEFAULT 100 CHECK (fly_interval_quantity >= 0),
  updated_by BIGINT REFERENCES mic2.employees(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE mic2.qc_fly_control_events
  ADD COLUMN IF NOT EXISTS output_quantity_at_check INTEGER NOT NULL DEFAULT 0 CHECK (output_quantity_at_check >= 0);
COMMIT;
