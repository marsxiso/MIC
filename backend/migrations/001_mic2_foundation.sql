-- MIC 2.0 foundation schema
-- This migration creates an isolated schema and does not alter legacy public tables.
-- Apply only to a dedicated test database after review.

BEGIN;

CREATE SCHEMA IF NOT EXISTS mic2;

CREATE TABLE mic2.roles (
  code TEXT PRIMARY KEY,
  title TEXT NOT NULL UNIQUE
);

INSERT INTO mic2.roles (code, title) VALUES
  ('cnc_operator', 'Оператор ЧПУ'),
  ('qc_controller', 'Контролёр ОТК'),
  ('production_manager', 'Начальник производства'),
  ('qc_manager', 'Начальник ОТК'),
  ('technical_director', 'Технический директор'),
  ('administrator', 'Администратор')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE mic2.employees (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_no TEXT UNIQUE,
  full_name TEXT NOT NULL,
  department TEXT NOT NULL CHECK (department IN ('production', 'qc', 'management', 'administration')),
  job_title TEXT NOT NULL,
  role_code TEXT NOT NULL REFERENCES mic2.roles(code),
  login TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
  account_status TEXT NOT NULL DEFAULT 'active' CHECK (account_status IN ('active', 'blocked')),
  hired_at DATE,
  terminated_at DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (terminated_at IS NULL OR hired_at IS NULL OR terminated_at >= hired_at)
);

CREATE TABLE mic2.employee_role_history (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_id BIGINT NOT NULL REFERENCES mic2.employees(id) ON DELETE RESTRICT,
  old_department TEXT,
  old_job_title TEXT,
  old_role_code TEXT REFERENCES mic2.roles(code),
  new_department TEXT NOT NULL,
  new_job_title TEXT NOT NULL,
  new_role_code TEXT NOT NULL REFERENCES mic2.roles(code),
  changed_by BIGINT REFERENCES mic2.employees(id) ON DELETE SET NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  note TEXT
);

CREATE TABLE mic2.shift_assignments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_id BIGINT NOT NULL REFERENCES mic2.employees(id) ON DELETE RESTRICT,
  shift_date DATE NOT NULL,
  shift_code TEXT NOT NULL,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  assigned_by BIGINT REFERENCES mic2.employees(id) ON DELETE SET NULL,
  attendance_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (attendance_status IN ('pending', 'present', 'absent', 'replaced')),
  attendance_confirmed_by BIGINT REFERENCES mic2.employees(id) ON DELETE SET NULL,
  attendance_confirmed_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (employee_id, shift_date, shift_code),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);

CREATE TABLE mic2.products (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_code TEXT NOT NULL UNIQUE,
  product_name TEXT NOT NULL,
  description TEXT,
  box_quantity_norm INTEGER NOT NULL CHECK (box_quantity_norm > 0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT REFERENCES mic2.employees(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE mic2.product_setups (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES mic2.products(id) ON DELETE RESTRICT,
  setup_code TEXT NOT NULL,
  setup_name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (product_id, setup_code),
  UNIQUE (id, product_id)
);

CREATE TABLE mic2.product_drawings (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES mic2.products(id) ON DELETE RESTRICT,
  version_no INTEGER NOT NULL CHECK (version_no > 0),
  file_uri TEXT NOT NULL,
  original_filename TEXT,
  uploaded_by BIGINT REFERENCES mic2.employees(id) ON DELETE SET NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_current BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (product_id, version_no)
);
CREATE UNIQUE INDEX product_drawings_one_current
  ON mic2.product_drawings(product_id) WHERE is_current;

CREATE TABLE mic2.measurement_cards (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  setup_id BIGINT NOT NULL REFERENCES mic2.product_setups(id) ON DELETE RESTRICT,
  version_no INTEGER NOT NULL CHECK (version_no > 0),
  source_type TEXT NOT NULL CHECK (source_type IN ('manual', 'uploaded')),
  source_file_uri TEXT,
  review_status TEXT NOT NULL DEFAULT 'draft'
    CHECK (review_status IN ('draft', 'checked', 'active', 'archived')),
  created_by BIGINT REFERENCES mic2.employees(id) ON DELETE SET NULL,
  checked_by BIGINT REFERENCES mic2.employees(id) ON DELETE SET NULL,
  checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (setup_id, version_no)
);

CREATE TABLE mic2.measurement_parameters (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  card_id BIGINT NOT NULL REFERENCES mic2.measurement_cards(id) ON DELETE RESTRICT,
  sort_order INTEGER NOT NULL,
  parameter_name TEXT NOT NULL,
  nominal_value TEXT,
  tolerance_text TEXT,
  unit TEXT,
  instruction TEXT,
  UNIQUE (card_id, sort_order)
);

CREATE TABLE mic2.plastic_bins (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bin_number BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  bin_status TEXT NOT NULL DEFAULT 'free'
    CHECK (bin_status IN ('free', 'occupied', 'archived')),
  created_by BIGINT REFERENCES mic2.employees(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_by BIGINT REFERENCES mic2.employees(id) ON DELETE SET NULL,
  archived_at TIMESTAMPTZ
);

CREATE TABLE mic2.production_cycles (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bin_id BIGINT NOT NULL REFERENCES mic2.plastic_bins(id) ON DELETE RESTRICT,
  cycle_no INTEGER NOT NULL CHECK (cycle_no > 0),
  product_id BIGINT NOT NULL REFERENCES mic2.products(id) ON DELETE RESTRICT,
  setup_id BIGINT NOT NULL,
  card_id BIGINT REFERENCES mic2.measurement_cards(id) ON DELETE RESTRICT,
  started_by BIGINT NOT NULL REFERENCES mic2.employees(id) ON DELETE RESTRICT,
  responsible_employee_id BIGINT NOT NULL REFERENCES mic2.employees(id) ON DELETE RESTRICT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  cycle_status TEXT NOT NULL DEFAULT 'active'
    CHECK (cycle_status IN ('active', 'completed', 'cancelled')),
  product_code_snapshot TEXT NOT NULL,
  product_name_snapshot TEXT NOT NULL,
  setup_code_snapshot TEXT NOT NULL,
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  UNIQUE (bin_id, cycle_no),
  FOREIGN KEY (setup_id, product_id)
    REFERENCES mic2.product_setups(id, product_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX production_cycles_one_active_per_bin
  ON mic2.production_cycles(bin_id) WHERE cycle_status = 'active';

CREATE TABLE mic2.cycle_operator_periods (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cycle_id BIGINT NOT NULL REFERENCES mic2.production_cycles(id) ON DELETE RESTRICT,
  operator_id BIGINT NOT NULL REFERENCES mic2.employees(id) ON DELETE RESTRICT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  approved_by BIGINT REFERENCES mic2.employees(id) ON DELETE SET NULL,
  ended_by BIGINT REFERENCES mic2.employees(id) ON DELETE SET NULL,
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE UNIQUE INDEX cycle_operator_one_open_period
  ON mic2.cycle_operator_periods(cycle_id) WHERE ended_at IS NULL;

CREATE TABLE mic2.production_output_entries (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cycle_id BIGINT NOT NULL REFERENCES mic2.production_cycles(id) ON DELETE RESTRICT,
  operator_id BIGINT NOT NULL REFERENCES mic2.employees(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  shift_assignment_id BIGINT REFERENCES mic2.shift_assignments(id) ON DELETE SET NULL,
  entered_by BIGINT NOT NULL REFERENCES mic2.employees(id) ON DELETE RESTRICT,
  entered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  correction_of_id BIGINT REFERENCES mic2.production_output_entries(id) ON DELETE RESTRICT,
  correction_note TEXT
);

CREATE TABLE mic2.bin_transfers (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cycle_id BIGINT NOT NULL REFERENCES mic2.production_cycles(id) ON DELETE RESTRICT,
  from_employee_id BIGINT NOT NULL REFERENCES mic2.employees(id) ON DELETE RESTRICT,
  to_employee_id BIGINT NOT NULL REFERENCES mic2.employees(id) ON DELETE RESTRICT,
  outgoing_quantity INTEGER NOT NULL CHECK (outgoing_quantity >= 0),
  received_quantity INTEGER NOT NULL CHECK (received_quantity >= 0),
  discrepancy INTEGER GENERATED ALWAYS AS (received_quantity - outgoing_quantity) STORED,
  approved_by BIGINT NOT NULL REFERENCES mic2.employees(id) ON DELETE RESTRICT,
  transferred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ,
  CHECK (from_employee_id <> to_employee_id)
);

CREATE TABLE mic2.qc_round_schedules (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  round_name TEXT NOT NULL,
  round_time TIME NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT REFERENCES mic2.employees(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE mic2.qc_rounds (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  schedule_id BIGINT REFERENCES mic2.qc_round_schedules(id) ON DELETE SET NULL,
  scheduled_for TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (schedule_id, scheduled_for)
);

CREATE TABLE mic2.qc_round_bins (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  round_id BIGINT NOT NULL REFERENCES mic2.qc_rounds(id) ON DELETE RESTRICT,
  cycle_id BIGINT NOT NULL REFERENCES mic2.production_cycles(id) ON DELETE RESTRICT,
  bin_number_snapshot BIGINT NOT NULL,
  product_name_snapshot TEXT NOT NULL,
  setup_code_snapshot TEXT NOT NULL,
  UNIQUE (round_id, cycle_id)
);

CREATE TABLE mic2.qc_inspections (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cycle_id BIGINT NOT NULL REFERENCES mic2.production_cycles(id) ON DELETE RESTRICT,
  round_bin_id BIGINT REFERENCES mic2.qc_round_bins(id) ON DELETE RESTRICT,
  controller_id BIGINT NOT NULL REFERENCES mic2.employees(id) ON DELETE RESTRICT,
  inspection_type TEXT NOT NULL
    CHECK (inspection_type IN ('first_piece', 'scheduled_round', 'defect_recheck', 'rework_acceptance', 'isolator_return')),
  card_id BIGINT REFERENCES mic2.measurement_cards(id) ON DELETE RESTRICT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  is_saved_partial BOOLEAN NOT NULL DEFAULT FALSE,
  comment TEXT,
  CHECK (completed_at IS NULL OR completed_at >= started_at)
);

CREATE TABLE mic2.qc_measurement_results (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  inspection_id BIGINT NOT NULL REFERENCES mic2.qc_inspections(id) ON DELETE RESTRICT,
  parameter_id BIGINT NOT NULL REFERENCES mic2.measurement_parameters(id) ON DELETE RESTRICT,
  measured_value TEXT,
  comment TEXT,
  measured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (inspection_id, parameter_id)
);

CREATE TABLE mic2.operator_defect_reports (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cycle_id BIGINT NOT NULL REFERENCES mic2.production_cycles(id) ON DELETE RESTRICT,
  reported_by BIGINT NOT NULL REFERENCES mic2.employees(id) ON DELETE RESTRICT,
  suspected_quantity INTEGER NOT NULL CHECK (suspected_quantity > 0),
  description TEXT NOT NULL,
  photo_uri TEXT,
  report_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (report_status IN ('pending', 'confirmed', 'rejected', 'cancelled')),
  reviewed_by BIGINT REFERENCES mic2.employees(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  review_comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE mic2.defects (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cycle_id BIGINT NOT NULL REFERENCES mic2.production_cycles(id) ON DELETE RESTRICT,
  source_report_id BIGINT REFERENCES mic2.operator_defect_reports(id) ON DELETE RESTRICT,
  confirmed_by BIGINT NOT NULL REFERENCES mic2.employees(id) ON DELETE RESTRICT,
  confirmed_quantity INTEGER NOT NULL CHECK (confirmed_quantity > 0),
  defect_description TEXT NOT NULL,
  defect_status TEXT NOT NULL DEFAULT 'awaiting_decision'
    CHECK (defect_status IN ('awaiting_decision', 'active', 'resolved', 'cancelled')),
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ
);

CREATE TABLE mic2.defect_decisions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  defect_id BIGINT NOT NULL REFERENCES mic2.defects(id) ON DELETE RESTRICT,
  decision_type TEXT NOT NULL
    CHECK (decision_type IN ('with_good_product', 'isolator', 'rework')),
  decided_quantity INTEGER NOT NULL CHECK (decided_quantity > 0),
  decision_by BIGINT NOT NULL REFERENCES mic2.employees(id) ON DELETE RESTRICT,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  supersedes_decision_id BIGINT REFERENCES mic2.defect_decisions(id) ON DELETE RESTRICT,
  note TEXT
);

CREATE TABLE mic2.defect_dispositions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  defect_id BIGINT NOT NULL REFERENCES mic2.defects(id) ON DELETE RESTRICT,
  decision_id BIGINT REFERENCES mic2.defect_decisions(id) ON DELETE RESTRICT,
  disposition_type TEXT NOT NULL
    CHECK (disposition_type IN ('packed_with_good', 'isolator_in', 'isolator_out', 'rework_sent', 'rework_returned', 'accepted_after_rework', 'scrapped')),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  performed_by BIGINT REFERENCES mic2.employees(id) ON DELETE RESTRICT,
  confirmed_by BIGINT REFERENCES mic2.employees(id) ON DELETE RESTRICT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  note TEXT
);

CREATE TABLE mic2.isolator_movements (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  defect_id BIGINT NOT NULL REFERENCES mic2.defects(id) ON DELETE RESTRICT,
  movement_type TEXT NOT NULL CHECK (movement_type IN ('in', 'out', 'return_to_production')),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  confirmed_by BIGINT NOT NULL REFERENCES mic2.employees(id) ON DELETE RESTRICT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  note TEXT
);

CREATE TABLE mic2.rework_records (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  defect_id BIGINT NOT NULL REFERENCES mic2.defects(id) ON DELETE RESTRICT,
  quantity_sent INTEGER NOT NULL CHECK (quantity_sent > 0),
  quantity_returned INTEGER CHECK (quantity_returned >= 0),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  returned_at TIMESTAMPTZ,
  note TEXT
);

CREATE TABLE mic2.finished_boxes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  box_number BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  product_id BIGINT NOT NULL REFERENCES mic2.products(id) ON DELETE RESTRICT,
  product_code_snapshot TEXT NOT NULL,
  product_name_snapshot TEXT NOT NULL,
  box_norm_snapshot INTEGER NOT NULL CHECK (box_norm_snapshot > 0),
  quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  created_by BIGINT NOT NULL REFERENCES mic2.employees(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_by BIGINT REFERENCES mic2.employees(id) ON DELETE RESTRICT,
  closed_at TIMESTAMPTZ,
  CHECK (quantity <= box_norm_snapshot),
  CHECK (closed_at IS NULL OR closed_at >= created_at)
);

CREATE TABLE mic2.finished_box_additions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  box_id BIGINT NOT NULL REFERENCES mic2.finished_boxes(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  added_by BIGINT NOT NULL REFERENCES mic2.employees(id) ON DELETE RESTRICT,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_defect_id BIGINT REFERENCES mic2.defects(id) ON DELETE RESTRICT,
  note TEXT
);

CREATE TABLE mic2.notifications (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recipient_id BIGINT NOT NULL REFERENCES mic2.employees(id) ON DELETE RESTRICT,
  category TEXT NOT NULL CHECK (category IN ('important', 'work', 'info')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  related_entity_type TEXT,
  related_entity_id BIGINT,
  push_required BOOLEAN NOT NULL DEFAULT FALSE,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE mic2.audit_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id BIGINT REFERENCES mic2.employees(id) ON DELETE RESTRICT,
  actor_role_code TEXT REFERENCES mic2.roles(code),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id BIGINT,
  before_data JSONB,
  after_data JSONB,
  reason TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  request_id TEXT
);

CREATE TABLE mic2.backup_runs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  target_type TEXT NOT NULL CHECK (target_type IN ('cloud', 'local')),
  backup_uri TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed', 'verified')),
  checksum TEXT,
  error_message TEXT
);

CREATE INDEX production_cycles_product_started_idx
  ON mic2.production_cycles(product_id, started_at DESC);
CREATE INDEX production_output_cycle_idx
  ON mic2.production_output_entries(cycle_id, entered_at);
CREATE INDEX qc_inspections_cycle_idx
  ON mic2.qc_inspections(cycle_id, started_at DESC);
CREATE INDEX defects_status_idx
  ON mic2.defects(defect_status, confirmed_at DESC);
CREATE INDEX isolator_movements_defect_idx
  ON mic2.isolator_movements(defect_id, occurred_at);
CREATE INDEX finished_boxes_product_idx
  ON mic2.finished_boxes(product_id, created_at DESC);
CREATE INDEX notifications_unread_idx
  ON mic2.notifications(recipient_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX audit_log_entity_idx
  ON mic2.audit_log(entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_log_actor_idx
  ON mic2.audit_log(actor_id, occurred_at DESC);

COMMIT;
