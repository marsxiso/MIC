-- MIC 2.0: audited corrections to bin-transfer recounts
-- Keeps original sender/receiver declarations immutable and stores every correction.
-- Apply only to the dedicated mic_test database after migrations 001-006.

BEGIN;

CREATE TABLE IF NOT EXISTS mic2.bin_transfer_corrections (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transfer_id BIGINT NOT NULL REFERENCES mic2.bin_transfers(id) ON DELETE RESTRICT,
  corrected_outgoing_quantity INTEGER NOT NULL CHECK (corrected_outgoing_quantity >= 0),
  corrected_received_quantity INTEGER NOT NULL CHECK (corrected_received_quantity >= 0),
  corrected_by BIGINT NOT NULL REFERENCES mic2.employees(id) ON DELETE RESTRICT,
  correction_reason TEXT NOT NULL CHECK (length(btrim(correction_reason)) > 0),
  corrected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bin_transfer_corrections_latest_idx
  ON mic2.bin_transfer_corrections(transfer_id, corrected_at DESC, id DESC);

CREATE OR REPLACE VIEW mic2.v_bin_transfers_effective AS
SELECT
  bt.id AS transfer_id,
  bt.cycle_id,
  bt.from_employee_id,
  bt.to_employee_id,
  bt.outgoing_quantity AS original_outgoing_quantity,
  bt.received_quantity AS original_received_quantity,
  bt.discrepancy AS original_discrepancy,
  COALESCE(latest.corrected_outgoing_quantity, bt.outgoing_quantity) AS effective_outgoing_quantity,
  COALESCE(latest.corrected_received_quantity, bt.received_quantity) AS effective_received_quantity,
  COALESCE(
    latest.corrected_received_quantity - latest.corrected_outgoing_quantity,
    bt.discrepancy
  ) AS effective_discrepancy,
  latest.id AS latest_correction_id,
  latest.corrected_by AS latest_corrected_by,
  latest.corrected_at AS latest_corrected_at,
  latest.correction_reason
FROM mic2.bin_transfers bt
LEFT JOIN LATERAL (
  SELECT c.*
  FROM mic2.bin_transfer_corrections c
  WHERE c.transfer_id = bt.id
  ORDER BY c.corrected_at DESC, c.id DESC
  LIMIT 1
) latest ON TRUE;

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
  v_role TEXT;
  v_old_outgoing INTEGER;
  v_old_received INTEGER;
  v_new_id BIGINT;
BEGIN
  IF p_corrected_outgoing_quantity < 0 OR p_corrected_received_quantity < 0 THEN
    RAISE EXCEPTION 'Corrected quantities cannot be negative';
  END IF;

  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'A correction reason is required';
  END IF;

  SELECT role_code
    INTO v_role
  FROM mic2.employees
  WHERE id = p_corrected_by
    AND account_status = 'active';

  IF v_role IS NULL OR v_role NOT IN ('production_manager', 'administrator') THEN
    RAISE EXCEPTION 'Only production manager or administrator can correct a bin transfer';
  END IF;

  SELECT outgoing_quantity, received_quantity
    INTO v_old_outgoing, v_old_received
  FROM mic2.bin_transfers
  WHERE id = p_transfer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bin transfer % does not exist', p_transfer_id;
  END IF;

  SELECT COALESCE(c.corrected_outgoing_quantity, v_old_outgoing),
         COALESCE(c.corrected_received_quantity, v_old_received)
    INTO v_old_outgoing, v_old_received
  FROM (SELECT 1) seed
  LEFT JOIN LATERAL (
    SELECT corrected_outgoing_quantity, corrected_received_quantity
    FROM mic2.bin_transfer_corrections
    WHERE transfer_id = p_transfer_id
    ORDER BY corrected_at DESC, id DESC
    LIMIT 1
  ) c ON TRUE;

  INSERT INTO mic2.bin_transfer_corrections (
    transfer_id, corrected_outgoing_quantity, corrected_received_quantity,
    corrected_by, correction_reason
  )
  VALUES (
    p_transfer_id, p_corrected_outgoing_quantity, p_corrected_received_quantity,
    p_corrected_by, btrim(p_reason)
  )
  RETURNING id INTO v_new_id;

  INSERT INTO mic2.audit_log (
    actor_id, actor_role_code, action, entity_type, entity_id,
    before_data, after_data, reason
  )
  VALUES (
    p_corrected_by, v_role, 'bin_transfer_corrected', 'bin_transfer', p_transfer_id,
    jsonb_build_object(
      'outgoing_quantity', v_old_outgoing,
      'received_quantity', v_old_received,
      'discrepancy', v_old_received - v_old_outgoing
    ),
    jsonb_build_object(
      'outgoing_quantity', p_corrected_outgoing_quantity,
      'received_quantity', p_corrected_received_quantity,
      'discrepancy', p_corrected_received_quantity - p_corrected_outgoing_quantity,
      'correction_id', v_new_id
    ),
    btrim(p_reason)
  );

  RETURN v_new_id;
END;
$$;

COMMIT;
