BEGIN;

CREATE SEQUENCE IF NOT EXISTS mic2.finished_boxes_id_seq;
SELECT setval('mic2.finished_boxes_id_seq',
  GREATEST(COALESCE((SELECT MAX(id) FROM mic2.finished_boxes), 0) + 1, 1),
  false);

ALTER TABLE mic2.finished_boxes
  ALTER COLUMN id SET DEFAULT nextval('mic2.finished_boxes_id_seq'),
  ADD COLUMN IF NOT EXISTS cycle_id bigint REFERENCES mic2.production_cycles(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS source_bin_id bigint REFERENCES mic2.plastic_bins(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS inspection_id bigint REFERENCES mic2.qc_inspections(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS finished_boxes_cycle_idx ON mic2.finished_boxes(cycle_id);
CREATE INDEX IF NOT EXISTS finished_boxes_source_bin_idx ON mic2.finished_boxes(source_bin_id);

COMMIT;
