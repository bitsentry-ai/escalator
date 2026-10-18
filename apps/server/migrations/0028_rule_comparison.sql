-- Old decisions have unknown availability and mode. Do not backdate either.
ALTER TABLE escalator_rule_decision ADD COLUMN recorded_at timestamptz;
ALTER TABLE escalator_rule_decision ALTER COLUMN recorded_at SET DEFAULT clock_timestamp();
ALTER TABLE escalator_rule_decision ADD COLUMN mode text;
ALTER TABLE escalator_rule_decision ADD CONSTRAINT escalator_rule_decision_mode CHECK(mode IS NULL OR mode IN ('active','shadow'));
CREATE INDEX escalator_rule_decision_comparison ON escalator_rule_decision(workspace_id,decision_at);
