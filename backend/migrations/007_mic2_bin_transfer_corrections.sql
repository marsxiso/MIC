-- MIC 2.0: align transfer-correction migration with migration 005.
-- The workflow migration (005) creates the canonical append-only correction
-- table and effective view. This migration is safe after 001-006 and keeps
-- the same view column names/order so CREATE OR REPLACE VIEW succeeds.

BEGIN;

CREATE TABLE IF NOT EXISTS mic2.bin_transfer_corrections (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transfer_id BIGINT NOT NULL REFERENCES mic2.bin_transfers(id) ON DELETE RESTRICT,
  original_outgoing_quantity INTEGER NOT NULL CHECK (original_outgoing_quantity >= 0),
  original_received_quantity INTEGER NOT NULL CHECK (original_received_quantity >= 0),
  corrected_outgoing_quantity INTEGER NOT NULL CHECK (corrected_outgoing_quantity >= 0),
  corrected_received_quantity INTEGER NOT NULL CHECK (corrected_received_quantity >= 0),
  corrected_by BIGINT NOT NULL REFERENCES mic2.employees(id) ON DELETE RESTRICT,
  corrected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0)
);

CREATE INDEX IF NOT EXISTS bin_transfer_corrections_transfer_idx
  ON mic2.bin_transfer_corrections(transfer_id, corrected_at DESC);

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
  c.reason AS correction_reason
FROM mic2.bin_transfers t
LEFT JOIN LATERAL (
  SELECT *
  FROM mic2.bin_transfer_corrections x
  WHERE x.transfer_id = t.id
  ORDER BY x.corrected_at DESC, x.id DESC
  LIMIT 1
) c ON TRUE;

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
    corrected_by, reason
  )
  VALUES (
    p_transfer_id,
    v_transfer.outgoing_quantity, v_transfer.received_quantity,
    p_corrected_outgoing_quantity, p_corrected_received_quantity,
    p_corrected_by, trim(p_reason)
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
    trim(p_reason)
  );

  RETURN v_correction_id;
END;
$$;

COMMIT;
