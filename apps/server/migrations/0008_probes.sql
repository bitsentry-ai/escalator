CREATE TABLE escalator_probe (
  workspace_id text NOT NULL REFERENCES escalator_workspace(id),
  id text COLLATE "C" NOT NULL,
  source_id text NOT NULL,
  service_id text NOT NULL,
  environment_id text NOT NULL,
  auth_secret_id text,
  version bigint NOT NULL CHECK (version > 0),
  data jsonb NOT NULL,
  PRIMARY KEY (workspace_id,id),
  UNIQUE (workspace_id,source_id),
  FOREIGN KEY (workspace_id,source_id) REFERENCES escalator_signal_source(workspace_id,id),
  FOREIGN KEY (workspace_id,service_id) REFERENCES escalator_service(workspace_id,id),
  FOREIGN KEY (workspace_id,environment_id) REFERENCES escalator_environment(workspace_id,id),
  FOREIGN KEY (workspace_id,auth_secret_id) REFERENCES escalator_secret(workspace_id,id),
  CHECK (jsonb_typeof(data) = 'object' AND NOT (data ? 'workspaceId')),
  CHECK (data->>'id' IS NOT NULL AND data->>'id' = id),
  CHECK (data->>'sourceId' IS NOT NULL AND data->>'sourceId' = source_id),
  CHECK (data->>'serviceId' IS NOT NULL AND data->>'serviceId' = service_id),
  CHECK (data->>'environmentId' IS NOT NULL AND data->>'environmentId' = environment_id),
  CHECK ((data->>'version')::bigint IS NOT NULL AND (data->>'version')::bigint = version),
  CHECK (auth_secret_id IS NOT DISTINCT FROM (data->'config'->>'authSecretId'))
);
ALTER TABLE escalator_probe ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_probe FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_probe_scope ON escalator_probe
  USING (workspace_id = current_setting('app.workspace_id',true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id',true));

CREATE TABLE escalator_probe_result (
  workspace_id text NOT NULL REFERENCES escalator_workspace(id),
  id text COLLATE "C" NOT NULL,
  probe_id text NOT NULL,
  observed_at timestamptz NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (workspace_id,id),
  UNIQUE (workspace_id,probe_id,id),
  FOREIGN KEY (workspace_id,probe_id) REFERENCES escalator_probe(workspace_id,id),
  CHECK (jsonb_typeof(data) = 'object' AND NOT (data ? 'workspaceId')),
  CHECK (data->>'id' IS NOT NULL AND data->>'id' = id),
  CHECK (data->>'probeId' IS NOT NULL AND data->>'probeId' = probe_id),
  CHECK ((data->>'observedAt')::timestamptz IS NOT NULL AND (data->>'observedAt')::timestamptz = observed_at)
);
ALTER TABLE escalator_probe_result ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_probe_result FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_probe_result_scope ON escalator_probe_result
  USING (workspace_id = current_setting('app.workspace_id',true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id',true));

CREATE TABLE escalator_probe_state (
  workspace_id text NOT NULL REFERENCES escalator_workspace(id),
  probe_id text COLLATE "C" NOT NULL,
  last_result_id text NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (workspace_id,probe_id),
  FOREIGN KEY (workspace_id,probe_id) REFERENCES escalator_probe(workspace_id,id),
  FOREIGN KEY (workspace_id,probe_id,last_result_id) REFERENCES escalator_probe_result(workspace_id,probe_id,id),
  CHECK (jsonb_typeof(data) = 'object' AND NOT (data ? 'workspaceId')),
  CHECK (data->>'probeId' IS NOT NULL AND data->>'probeId' = probe_id),
  CHECK (data->>'lastResultId' IS NOT NULL AND data->>'lastResultId' = last_result_id)
);
ALTER TABLE escalator_probe_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_probe_state FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_probe_state_scope ON escalator_probe_state
  USING (workspace_id = current_setting('app.workspace_id',true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id',true));

CREATE TABLE escalator_probe_schedule (
  workspace_id text NOT NULL REFERENCES escalator_workspace(id),
  probe_id text COLLATE "C" NOT NULL,
  job_id text,
  due_at timestamptz,
  data jsonb NOT NULL,
  PRIMARY KEY (workspace_id,probe_id),
  FOREIGN KEY (workspace_id,probe_id) REFERENCES escalator_probe(workspace_id,id),
  CHECK (jsonb_typeof(data) = 'object' AND NOT (data ? 'workspaceId')),
  CHECK (data->>'probeId' IS NOT NULL AND data->>'probeId' = probe_id),
  CHECK ((job_id IS NULL) = (due_at IS NULL)),
  CHECK (job_id IS NOT DISTINCT FROM (data->>'jobId')),
  CHECK (due_at IS NOT DISTINCT FROM (data->>'dueAt')::timestamptz)
);
ALTER TABLE escalator_probe_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_probe_schedule FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_probe_schedule_scope ON escalator_probe_schedule
  USING (workspace_id = current_setting('app.workspace_id',true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id',true));

CREATE INDEX escalator_probe_result_retention ON escalator_probe_result(workspace_id,observed_at,id);
CREATE INDEX escalator_probe_schedule_due ON escalator_probe_schedule(workspace_id,due_at,probe_id) WHERE job_id IS NOT NULL;
