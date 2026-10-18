-- Ready proposals retain both required reports until the proposal is removed.
ALTER TABLE escalator_rule_proposal ADD COLUMN full_report_run_id text COLLATE "C";
ALTER TABLE escalator_rule_proposal ADD COLUMN held_out_report_run_id text COLLATE "C";
ALTER TABLE escalator_rule_proposal ADD FOREIGN KEY(workspace_id,full_report_run_id) REFERENCES escalator_rule_backtest(workspace_id,run_id);
ALTER TABLE escalator_rule_proposal ADD FOREIGN KEY(workspace_id,held_out_report_run_id) REFERENCES escalator_rule_backtest(workspace_id,run_id);
CREATE INDEX escalator_rule_proposal_full_report ON escalator_rule_proposal(workspace_id,full_report_run_id);
CREATE INDEX escalator_rule_proposal_held_report ON escalator_rule_proposal(workspace_id,held_out_report_run_id);
ALTER TABLE escalator_rule_proposal ADD CONSTRAINT escalator_rule_proposal_report_pins CHECK(
 (status <> 'ready' AND full_report_run_id IS NULL AND held_out_report_run_id IS NULL) OR
 (status = 'ready' AND full_report_run_id IS NOT NULL AND data->>'fullRunId' IS NOT NULL AND full_report_run_id=data->>'fullRunId' AND data->>'heldOut' IS NOT NULL AND
  ((data->>'heldOut'='required' AND held_out_report_run_id IS NOT NULL AND data->>'heldOutRunId' IS NOT NULL AND held_out_report_run_id=data->>'heldOutRunId') OR
   (data->>'heldOut'='insufficient_span' AND held_out_report_run_id IS NULL AND data->>'heldOutRunId' IS NULL)))
);
