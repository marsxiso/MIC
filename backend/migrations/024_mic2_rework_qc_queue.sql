-- Keep reworked quantities in a separate QC bucket and retain their source bucket on each new defect.
ALTER TABLE mic2.defects
  ADD COLUMN IF NOT EXISTS source_bucket TEXT NOT NULL DEFAULT 'production_pending_qc'
  CHECK (source_bucket IN ('production_pending_qc','rework_pending_qc'));

CREATE INDEX IF NOT EXISTS cycle_quantity_movements_rework_qc_idx
  ON mic2.cycle_quantity_movements(defect_id, occurred_at, id)
  WHERE to_bucket='rework_pending_qc' OR from_bucket='rework_pending_qc';
