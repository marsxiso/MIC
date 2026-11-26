-- MIC 2.0 QC defect decision workflow extension
ALTER TABLE mic2.defect_decisions DROP CONSTRAINT IF EXISTS defect_decisions_decision_type_check;
ALTER TABLE mic2.defect_decisions ADD CONSTRAINT defect_decisions_decision_type_check
 CHECK (decision_type IN ('with_good_product','isolator','rework','scrap'));
CREATE INDEX IF NOT EXISTS defect_decisions_defect_idx ON mic2.defect_decisions(defect_id,decided_at,id);
