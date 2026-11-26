-- MIC 2.0: dedicated fly-control workflow and employee self-service shift access.
ALTER TABLE mic2.qc_inspections DROP CONSTRAINT IF EXISTS qc_inspections_inspection_type_check;
ALTER TABLE mic2.qc_inspections ADD CONSTRAINT qc_inspections_inspection_type_check
 CHECK (inspection_type IN ('first_piece','scheduled_round','defect_recheck','rework_acceptance','isolator_return','fly_control'));

CREATE TABLE mic2.qc_fly_control_events (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 inspection_id BIGINT NOT NULL UNIQUE REFERENCES mic2.qc_inspections(id) ON DELETE RESTRICT,
 sample_quantity INTEGER NOT NULL CHECK (sample_quantity > 0),
 inspection_result TEXT NOT NULL CHECK (inspection_result IN ('pass','fail','observation')),
 defect_quantity INTEGER NOT NULL DEFAULT 0 CHECK (defect_quantity >= 0),
 defect_description TEXT,
 action_required BOOLEAN NOT NULL DEFAULT FALSE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK (defect_quantity <= sample_quantity),
 CHECK ((inspection_result <> 'fail') OR (defect_quantity > 0 AND defect_description IS NOT NULL))
);
CREATE INDEX qc_fly_control_created_idx ON mic2.qc_fly_control_events(created_at DESC);
CREATE INDEX qc_inspections_type_created_idx ON mic2.qc_inspections(inspection_type,started_at DESC);
