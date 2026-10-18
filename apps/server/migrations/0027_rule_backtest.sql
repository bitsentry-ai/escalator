CREATE TABLE escalator_rule_backtest (
 workspace_id text COLLATE "C" NOT NULL,
 run_id text COLLATE "C" NOT NULL,
 snapshot_id text COLLATE "C" NOT NULL,
 input_hash text COLLATE "C" NOT NULL,
 data jsonb NOT NULL,
 PRIMARY KEY(workspace_id,run_id),
 FOREIGN KEY(workspace_id,run_id,snapshot_id) REFERENCES escalator_rule_replay_run(workspace_id,id,snapshot_id),
 FOREIGN KEY(workspace_id,snapshot_id,input_hash) REFERENCES escalator_rule_replay_snapshot(workspace_id,id,input_hash),
 CHECK(jsonb_typeof(data)='object' AND octet_length(data::text)<=16777216 AND NOT(data ? 'workspaceId')),
 CHECK(data->>'runId' IS NOT NULL AND data->>'runId'=run_id),
 CHECK(data->>'snapshotId' IS NOT NULL AND data->>'snapshotId'=snapshot_id),
 CHECK(data->>'inputHash' IS NOT NULL AND data->>'inputHash'=input_hash)
);
CREATE INDEX escalator_rule_backtest_snapshot ON escalator_rule_backtest(workspace_id,snapshot_id);
ALTER TABLE escalator_rule_backtest ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_rule_backtest FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_rule_backtest_scope ON escalator_rule_backtest
 USING(workspace_id=current_setting('app.workspace_id',true))
 WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
CREATE TRIGGER escalator_rule_backtest_immutable BEFORE UPDATE ON escalator_rule_backtest
 FOR EACH ROW EXECUTE FUNCTION escalator_rule_immutable();
