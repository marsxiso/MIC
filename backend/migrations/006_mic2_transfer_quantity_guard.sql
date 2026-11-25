-- MIC 2.0 transfer quantity guard
-- Apply after migrations 001-005 on a dedicated local/test database.
-- The sender's declared quantity cannot exceed the current physical balance
-- still inside the reusable plastic bin. The receiver's recount may differ;
-- the discrepancy is retained in bin_transfers and the effective view.

BEGIN;

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
  v_bin_quantity BIGINT;
BEGIN
  IF p_from_employee_id = p_to_employee_id THEN
    RAISE EXCEPTION 'Sender and receiver must be different employees';
  END IF;

  IF p_outgoing_quantity < 0 OR p_received_quantity < 0 THEN
    RAISE EXCEPTION 'Transfer quantities cannot be negative';
  END IF;

  -- Serialize transfer and quantity checks for this cycle.
  PERFORM 1
  FROM mic2.production_cycles
  WHERE id = p_cycle_id AND cycle_status = 'active'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Production cycle % does not exist or is not active', p_cycle_id;
  END IF;

  -- Count only pieces physically remaining in the plastic bin.
  -- Rework/isolator external, packed and scrapped quantities have left it.
  SELECT COALESCE(SUM(quantity), 0)
    INTO v_bin_quantity
  FROM mic2.v_cycle_quantity_balances
  WHERE cycle_id = p_cycle_id
    AND bucket NOT IN (
      'rework_external',
      'isolator_external',
      'packed',
      'scrapped'
    );

  IF p_outgoing_quantity > v_bin_quantity THEN
    RAISE EXCEPTION
      'Outgoing quantity % exceeds physical bin balance % for cycle %',
      p_outgoing_quantity, v_bin_quantity, p_cycle_id;
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
      'discrepancy', p_received_quantity - p_outgoing_quantity,
      'physical_bin_balance_at_transfer', v_bin_quantity
    )
  );

  RETURN v_transfer_id;
END;
$$;

COMMIT;
