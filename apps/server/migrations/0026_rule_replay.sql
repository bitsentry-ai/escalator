-- Snapshots and result chunks are never overwritten. Terminal replay evidence
-- may later be removed by an explicitly audited retention transaction.
CREATE TABLE escalator_rule_replay_snapshot (
 workspace_id text COLLATE "C" NOT NULL REFERENCES escalator_workspace(id),
 id text COLLATE "C" NOT NULL,
 input_hash text COLLATE "C" NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),
 service_id text COLLATE "C" NOT NULL,
 environment_id text COLLATE "C" NOT NULL,
 data jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,id),
 UNIQUE(workspace_id,id,input_hash),
 FOREIGN KEY(workspace_id,service_id) REFERENCES escalator_service(workspace_id,id),
 FOREIGN KEY(workspace_id,environment_id) REFERENCES escalator_environment(workspace_id,id),
 CHECK(jsonb_typeof(data)='object' AND octet_length(data::text)<=16777216 AND NOT(data ? 'workspaceId')),
 CHECK(data->>'snapshotId' IS NOT NULL AND data->>'snapshotId'=id),
 CHECK(data->'version'->'definition'->>'serviceId' IS NOT NULL AND data->'version'->'definition'->>'serviceId'=service_id),
 CHECK(data->'version'->'definition'->>'environmentId' IS NOT NULL AND data->'version'->'definition'->>'environmentId'=environment_id)
);
CREATE INDEX escalator_replay_snapshot_retention ON escalator_rule_replay_snapshot(workspace_id,created_at,id);
CREATE TABLE escalator_rule_replay_run (
 workspace_id text COLLATE "C" NOT NULL,
 id text COLLATE "C" NOT NULL,
 snapshot_id text COLLATE "C" NOT NULL,
 input_hash text COLLATE "C" NOT NULL,
 revision bigint NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
 status text COLLATE "C" NOT NULL CHECK(status IN ('queued','running','completed','cancelled')),
 next_batch integer NOT NULL CHECK(next_batch BETWEEN 0 AND 44641),
 data jsonb NOT NULL,
 PRIMARY KEY(workspace_id,id),
 UNIQUE(workspace_id,id,snapshot_id),
 FOREIGN KEY(workspace_id,snapshot_id,input_hash) REFERENCES escalator_rule_replay_snapshot(workspace_id,id,input_hash),
 CHECK(jsonb_typeof(data)='object' AND octet_length(data::text)<=16384 AND NOT(data ? 'workspaceId')),
 CHECK(data->>'id' IS NOT NULL AND data->>'id'=id),
 CHECK(data->>'snapshotId' IS NOT NULL AND data->>'snapshotId'=snapshot_id),
 CHECK(data->>'inputHash' IS NOT NULL AND data->>'inputHash'=input_hash),
 CHECK((data->>'revision')::bigint IS NOT NULL AND (data->>'revision')::bigint=revision),
 CHECK(data->>'status' IS NOT NULL AND data->>'status'=status),
 CHECK((data->>'nextBatch')::integer IS NOT NULL AND (data->>'nextBatch')::integer=next_batch)
);
CREATE TABLE escalator_rule_replay_chunk (
 workspace_id text COLLATE "C" NOT NULL,
 run_id text COLLATE "C" NOT NULL,
 batch integer NOT NULL CHECK(batch BETWEEN 0 AND 44640),
 snapshot_id text COLLATE "C" NOT NULL,
 data jsonb NOT NULL,
 PRIMARY KEY(workspace_id,run_id,batch),
 FOREIGN KEY(workspace_id,run_id,snapshot_id) REFERENCES escalator_rule_replay_run(workspace_id,id,snapshot_id),
 CHECK(jsonb_typeof(data)='object' AND octet_length(data::text)<=262144 AND NOT(data ? 'workspaceId')),
 CHECK(data->>'runId' IS NOT NULL AND data->>'runId'=run_id),
 CHECK(data->>'snapshotId' IS NOT NULL AND data->>'snapshotId'=snapshot_id),
 CHECK((data->>'batch')::integer IS NOT NULL AND (data->>'batch')::integer=batch),
 CHECK(data->'decisions' IS NOT NULL AND jsonb_typeof(data->'decisions')='array' AND jsonb_array_length(data->'decisions') BETWEEN 1 AND 60)
);
ALTER TABLE escalator_rule_replay_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_rule_replay_snapshot FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_rule_replay_snapshot_scope ON escalator_rule_replay_snapshot
 USING(workspace_id=current_setting('app.workspace_id',true))
 WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
ALTER TABLE escalator_rule_replay_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_rule_replay_run FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_rule_replay_run_scope ON escalator_rule_replay_run
 USING(workspace_id=current_setting('app.workspace_id',true))
 WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
ALTER TABLE escalator_rule_replay_chunk ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_rule_replay_chunk FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_rule_replay_chunk_scope ON escalator_rule_replay_chunk
 USING(workspace_id=current_setting('app.workspace_id',true))
 WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
CREATE TRIGGER escalator_replay_snapshot_immutable BEFORE UPDATE ON escalator_rule_replay_snapshot
 FOR EACH ROW EXECUTE FUNCTION escalator_rule_immutable();
CREATE TRIGGER escalator_replay_chunk_immutable BEFORE UPDATE ON escalator_rule_replay_chunk
 FOR EACH ROW EXECUTE FUNCTION escalator_rule_immutable();
CREATE FUNCTION escalator_guard_rule_replay_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.status NOT IN ('completed','cancelled') THEN RAISE EXCEPTION 'Pending replay cannot be deleted' USING ERRCODE='23514'; END IF;
  RETURN OLD;
 END IF;
 IF OLD.status IN ('completed','cancelled') OR NEW.revision<>OLD.revision+1
  OR NEW.workspace_id<>OLD.workspace_id OR NEW.id<>OLD.id OR NEW.snapshot_id<>OLD.snapshot_id OR NEW.input_hash<>OLD.input_hash
  OR NEW.data->>'createdAt' IS DISTINCT FROM OLD.data->>'createdAt'
  OR NEW.status NOT IN ('running','completed','cancelled') THEN
  RAISE EXCEPTION 'Invalid replay run transition' USING ERRCODE='23514';
 END IF;
 IF NEW.status='cancelled' THEN
  IF NEW.next_batch<>OLD.next_batch OR NEW.data->'cursor' IS DISTINCT FROM OLD.data->'cursor'
   OR NEW.data->'decisionCount' IS DISTINCT FROM OLD.data->'decisionCount' THEN
   RAISE EXCEPTION 'Cancellation cannot rewrite replay results' USING ERRCODE='23514';
  END IF;
 ELSIF NEW.next_batch<>OLD.next_batch+1 THEN
  RAISE EXCEPTION 'Replay batch must advance once' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER escalator_replay_run_guard BEFORE UPDATE OR DELETE ON escalator_rule_replay_run
 FOR EACH ROW EXECUTE FUNCTION escalator_guard_rule_replay_run();
