-- MIC 2.0 controlled plastic-bin transfer workflow
-- Apply after migrations 001-004 on the local/test database.
-- Backend must derive actor IDs from the authenticated session, never trust
-- actor IDs supplied directly by the client.

BEGIN;

ALTER TABLE mic2.bin_transfers
  ADD CONSTRAINT bin_transfers_distinct_approver_ck
  CHECK (
    approved_by <> from_employee_id
    AND approved_by <> to_employee_id
  );

CREATE TABLE mic2.bin_transfer_corrections (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transfer_id BIGINT NOT NULL REFERENCES mic2.bin_transfers(id) ON DELETE RESTRICT,
  original_outgoing_quantity INTEGER NOT NULL CHECK (original_outgoing_quantity >= 0),
  original_received_quantity INTEGER NOT NULL CHECK (original_received_quantity >= 0),
  corrected_outgoing_quantity INTEGER NOT NULL CHECK (corrected_outgoing_quantity >= 0),
  corrected_received_quantity INTEGER NOT NULL CHECK (corrected_received_quantity >= 0),
  corrected_by BIGINT NOT NULL REFERENCES mic2.employees(id) ON DELETE RESTRICT,
  corrected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  correction_reason TEXT NOT NULL CHECK (length(trim(correction_reason)) > 0)
);

CREATE INDEX bin_transfer_corrections_transfer_idx
  ON mic2.bin_transfer_corrections(transfer_id, corrected_at DESC);

CREATE OR REPLACE FUNCTION mic2.execute_bin_transfer(
  p_cycle_id BIGINT,
  p_from_employee_id BIGINT,
  p_to_employee_id BIGINT,
  p_outgoing_quantity INTEGER,
  p_received_quantity INTEGER,
  p_approved_by BIGINT
)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
  v_transfer_id BIGINT;
  v_current_operator BIGINT;
  v_approver_role TEXT;
BEGIN
  IF p_from_employee_id = p_to_employee_id THEN
    RAISE EXCEPTION 'Sender and receiver must be different employees';
  END IF;

  IF p_outgoing_quantity < 0 OR p_received_quantity < 0 THEN
    RAISE EXCEPTION 'Transfer quantities cannot be negative';
  END IF;

  -- Serialize transfers on this production cycle.
  PERFORM 1
  FROM mic2.production_cycles
  WHERE id = p_cycle_id AND cycle_status = 'active'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Production cycle % does not exist or is not active', p_cycle_id;
  END IF;

  SELECT e.role_code
    INTO v_approver_role
  FROM mic2.employees e
  WHERE e.id = p_approved_by
    AND e.account_status = 'active';

  IF v_approver_role IS NULL OR v_approver_role NOT IN ('production_manager', 'administrator') THEN
    RAISE EXCEPTION 'Only production manager or administrator can approve a bin transfer';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM mic2.employees
    WHERE id = p_from_employee_id
      AND role_code = 'cnc_operator'
      AND account_status = 'active'
  ) OR NOT EXISTS (
    SELECT 1 FROM mic2.employees
    WHERE id = p_to_employee_id
      AND role_code = 'cnc_operator'
      AND account_status = 'active'
  ) THEN
    RAISE EXCEPTION 'Sender and receiver must be active CNC operators';
  END IF;

  SELECT operator_id
    INTO v_current_operator
  FROM mic2.cycle_operator_periods
  WHERE cycle_id = p_cycle_id AND ended_at IS NULL
  FOR UPDATE;

  IF v_current_operator IS NULL OR v_current_operator <> p_from_employee_id THEN
    RAISE EXCEPTION 'Sender is not the current responsible operator for cycle %', p_cycle_id;
  END IF;

  UPDATE mic2.cycle_operator_periods
  SET ended_at = now(),
      ended_by = p_approved_by
  WHERE cycle_id = p_cycle_id
    AND operator_id = p_from_employee_id
    AND ended_at IS NULL;

  INSERT INTO mic2.bin_transfers (
    cycle_id, from_employee_id, to_employee_id,
    outgoing_quantity, received_quantity,
    approved_by, transferred_at, confirmed_at
  )
  VALUES (
    p_cycle_id, p_from_employee_id, p_to_employee_id,
    p_outgoing_quantity, p_received_quantity,
    p_approved_by, now(), now()
  )
  RETURNING id INTO v_transfer_id;

  INSERT INTO mic2.cycle_operator_periods (
    cycle_id, operator_id, started_at, approved_by
  )
  VALUES (p_cycle_id, p_to_employee_id, now(), p_approved_by);

  UPDATE mic2.production_cycles
  SET responsible_employee_id = p_to_employee_id
  WHERE id = p_cycle_id;

  INSERT INTO mic2.audit_log (
    actor_id, actor_role_code, action, entity_type, entity_id,
    before_data, after_data
  )
  VALUES (
    p_approved_by, v_approver_role, 'bin_transfer_approved',
    'bin_transfer', v_transfer_id,
    jsonb_build_object('responsible_employee_id', p_from_employee_id),
    jsonb_build_object(
      'responsible_employee_id', p_to_employee_id,
      'outgoing_quantity', p_outgoing_quantity,
      'received_quantity', p_received_quantity,
      'discrepancy', p_received_quantity - p_outgoing_quantity
    )
  );

  RETURN v_transfer_id;
END;
$$;

CREATE OR REPLACE FUNCTION mic2.correct_bin_transfer(
  p_transfer_id BIGINT,
  p_corrected_outgoing_quantity INTEGER,
  p_corrected_received_quantity INTEGER,
  p_corrected_by BIGINT,
  p_reason TEXT
)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
  v_transfer mic2.bin_transfers%ROWTYPE;
  v_actor_role TEXT;
  v_correction_id BIGINT;
BEGIN
  IF p_corrected_outgoing_quantity < 0 OR p_corrected_received_quantity < 0 THEN
    RAISE EXCEPTION 'Corrected quantities cannot be negative';
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'A correction reason is required';
  END IF;

  SELECT *
    INTO v_transfer
  FROM mic2.bin_transfers
  WHERE id = p_transfer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transfer % does not exist', p_transfer_id;
  END IF;

  SELECT role_code
    INTO v_actor_role
  FROM mic2.employees
  WHERE id = p_corrected_by
    AND account_status = 'active';

  IF v_actor_role IS NULL OR v_actor_role NOT IN ('production_manager', 'administrator') THEN
    RAISE EXCEPTION 'Only production manager or administrator can correct a transfer discrepancy';
  END IF;

  INSERT INTO mic2.bin_transfer_corrections (
    transfer_id,
    original_outgoing_quantity, original_received_quantity,
    corrected_outgoing_quantity, corrected_received_quantity,
    corrected_by, correction_reason
  )
  VALUES (
    p_transfer_id,
    v_transfer.outgoing_quantity, v_transfer.received_quantity,
    p_corrected_outgoing_quantity, p_corrected_received_quantity,
    p_corrected_by, p_reason
  )
  RETURNING id INTO v_correction_id;

  INSERT INTO mic2.audit_log (
    actor_id, actor_role_code, action, entity_type, entity_id,
    before_data, after_data, reason
  )
  VALUES (
    p_corrected_by, v_actor_role, 'bin_transfer_corrected',
    'bin_transfer', p_transfer_id,
    jsonb_build_object(
      'outgoing_quantity', v_transfer.outgoing_quantity,
      'received_quantity', v_transfer.received_quantity,
      'discrepancy', v_transfer.discrepancy
    ),
    jsonb_build_object(
      'outgoing_quantity', p_corrected_outgoing_quantity,
      'received_quantity', p_corrected_received_quantity,
      'discrepancy', p_corrected_received_quantity - p_corrected_outgoing_quantity,
      'correction_id', v_correction_id
    ),
    p_reason
  );

  RETURN v_correction_id;
END;
$$;

-- Effective view preserves the original transfer and exposes the latest
-- manager/admin correction without rewriting the source record.
CREATE OR REPLACE VIEW mic2.v_bin_transfers_effective AS
SELECT
  t.id,
  t.cycle_id,
  t.from_employee_id,
  t.to_employee_id,
  COALESCE(c.corrected_outgoing_quantity, t.outgoing_quantity) AS outgoing_quantity,
  COALESCE(c.corrected_received_quantity, t.received_quantity) AS received_quantity,
  COALESCE(c.corrected_received_quantity, t.received_quantity)
    - COALESCE(c.corrected_outgoing_quantity, t.outgoing_quantity) AS discrepancy,
  t.outgoing_quantity AS original_outgoing_quantity,
  t.received_quantity AS original_received_quantity,
  t.approved_by,
  t.transferred_at,
  t.confirmed_at,
  c.corrected_by,
  c.corrected_at,
  c.correction_reason AS correction_reason
FROM mic2.bin_transfers t
LEFT JOIN LATERAL (
  SELECT *
  FROM mic2.bin_transfer_corrections x
  WHERE x.transfer_id = t.id
  ORDER BY x.corrected_at DESC, x.id DESC
  LIMIT 1
) c ON TRUE;

-- Corrections are append-only; never rewrite the correction history.
CREATE OR REPLACE FUNCTION mic2.prevent_bin_transfer_correction_rewrite()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Transfer corrections are append-only';
END;
$$;

CREATE TRIGGER bin_transfer_corrections_no_rewrite
BEFORE UPDATE OR DELETE
ON mic2.bin_transfer_corrections
FOR EACH ROW
EXECUTE FUNCTION mic2.prevent_bin_transfer_correction_rewrite();

COMMIT;
