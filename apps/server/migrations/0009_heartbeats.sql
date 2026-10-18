CREATE TABLE escalator_heartbeat_probe (
  workspace_id text NOT NULL REFERENCES escalator_workspace(id),
  id text COLLATE "C" NOT NULL,
  source_id text NOT NULL,
  service_id text NOT NULL,
  environment_id text NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  data jsonb NOT NULL,
  PRIMARY KEY (workspace_id,id),
  UNIQUE (workspace_id,source_id),
  FOREIGN KEY (workspace_id,source_id) REFERENCES escalator_signal_source(workspace_id,id),
  FOREIGN KEY (workspace_id,service_id) REFERENCES escalator_service(workspace_id,id),
  FOREIGN KEY (workspace_id,environment_id) REFERENCES escalator_environment(workspace_id,id)
);
CREATE TABLE escalator_heartbeat_grant (
  workspace_id text NOT NULL REFERENCES escalator_workspace(id),
  id text COLLATE "C" NOT NULL,
  probe_id text NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  data jsonb NOT NULL,
  PRIMARY KEY (workspace_id,id),
  UNIQUE (workspace_id,probe_id,id),
  FOREIGN KEY (workspace_id,probe_id) REFERENCES escalator_heartbeat_probe(workspace_id,id)
);
CREATE TABLE escalator_heartbeat_state (
  workspace_id text NOT NULL REFERENCES escalator_workspace(id),
  probe_id text COLLATE "C" NOT NULL,
  deadline_at timestamptz,
  deadline_job_id text,
  data jsonb NOT NULL,
  PRIMARY KEY (workspace_id,probe_id),
  FOREIGN KEY (workspace_id,probe_id) REFERENCES escalator_heartbeat_probe(workspace_id,id)
);
CREATE TABLE escalator_heartbeat_receipt (
  workspace_id text NOT NULL REFERENCES escalator_workspace(id),
  id text COLLATE "C" NOT NULL,
  probe_id text NOT NULL,
  event_id text NOT NULL,
  grant_id text NOT NULL,
  observed_at timestamptz NOT NULL,
  accepted_at timestamptz NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (workspace_id,id),
  UNIQUE (workspace_id,probe_id,event_id),
  FOREIGN KEY (workspace_id,probe_id) REFERENCES escalator_heartbeat_probe(workspace_id,id),
  FOREIGN KEY (workspace_id,probe_id,grant_id) REFERENCES escalator_heartbeat_grant(workspace_id,probe_id,id)
);
ALTER TABLE escalator_heartbeat_probe ADD CHECK (jsonb_typeof(data) = 'object' AND NOT (data ? 'workspaceId') AND NOT (data ? 'organizationId'));
ALTER TABLE escalator_heartbeat_probe ADD CHECK (data->>'id' IS NOT NULL AND data->>'id' = id);
ALTER TABLE escalator_heartbeat_probe ADD CHECK (data->>'sourceId' IS NOT NULL AND data->>'sourceId' = source_id);
ALTER TABLE escalator_heartbeat_probe ADD CHECK (data->>'serviceId' IS NOT NULL AND data->>'serviceId' = service_id);
ALTER TABLE escalator_heartbeat_probe ADD CHECK (data->>'environmentId' IS NOT NULL AND data->>'environmentId' = environment_id);
ALTER TABLE escalator_heartbeat_probe ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_heartbeat_probe FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_heartbeat_probe_scope ON escalator_heartbeat_probe
  USING (workspace_id = current_setting('app.workspace_id',true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id',true));
ALTER TABLE escalator_heartbeat_grant ADD CHECK (jsonb_typeof(data) = 'object' AND NOT (data ? 'workspaceId') AND NOT (data ? 'organizationId'));
ALTER TABLE escalator_heartbeat_grant ADD CHECK (data->>'id' IS NOT NULL AND data->>'id' = id);
ALTER TABLE escalator_heartbeat_grant ADD CHECK (data->>'probeId' IS NOT NULL AND data->>'probeId' = probe_id);
ALTER TABLE escalator_heartbeat_grant ADD CHECK (data->>'tokenHash' IS NOT NULL AND data->>'tokenHash' = token_hash);
ALTER TABLE escalator_heartbeat_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_heartbeat_grant FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_heartbeat_grant_scope ON escalator_heartbeat_grant
  USING (workspace_id = current_setting('app.workspace_id',true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id',true));
ALTER TABLE escalator_heartbeat_state ADD CHECK (jsonb_typeof(data) = 'object' AND NOT (data ? 'workspaceId') AND NOT (data ? 'organizationId'));
ALTER TABLE escalator_heartbeat_state ADD CHECK (data->>'probeId' IS NOT NULL AND data->>'probeId' = probe_id);
ALTER TABLE escalator_heartbeat_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_heartbeat_state FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_heartbeat_state_scope ON escalator_heartbeat_state
  USING (workspace_id = current_setting('app.workspace_id',true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id',true));
ALTER TABLE escalator_heartbeat_receipt ADD CHECK (jsonb_typeof(data) = 'object' AND NOT (data ? 'workspaceId') AND NOT (data ? 'organizationId'));
ALTER TABLE escalator_heartbeat_receipt ADD CHECK (data->>'id' IS NOT NULL AND data->>'id' = id);
ALTER TABLE escalator_heartbeat_receipt ADD CHECK (data->>'probeId' IS NOT NULL AND data->>'probeId' = probe_id);
ALTER TABLE escalator_heartbeat_receipt ADD CHECK (data->>'eventId' IS NOT NULL AND data->>'eventId' = event_id);
ALTER TABLE escalator_heartbeat_receipt ADD CHECK (data->>'grantId' IS NOT NULL AND data->>'grantId' = grant_id);
ALTER TABLE escalator_heartbeat_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_heartbeat_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_heartbeat_receipt_scope ON escalator_heartbeat_receipt
  USING (workspace_id = current_setting('app.workspace_id',true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id',true));
ALTER TABLE escalator_heartbeat_probe ADD CHECK ((data->>'version')::bigint IS NOT NULL AND (data->>'version')::bigint = version);
ALTER TABLE escalator_heartbeat_grant ADD CHECK (data->>'scope' IS NOT NULL AND data->>'scope' = 'heartbeat:write');
ALTER TABLE escalator_heartbeat_state
  ADD CHECK ((deadline_at IS NULL) = (deadline_job_id IS NULL)),
  ADD CHECK (data ? 'deadlineAt' AND deadline_at IS NOT DISTINCT FROM (data->>'deadlineAt')::timestamptz),
  ADD CHECK (data ? 'deadlineJobId' AND deadline_job_id IS NOT DISTINCT FROM (data->>'deadlineJobId'));
ALTER TABLE escalator_heartbeat_receipt
  ADD CHECK ((data->>'observedAt')::timestamptz IS NOT NULL AND (data->>'observedAt')::timestamptz = observed_at),
  ADD CHECK ((data->>'acceptedAt')::timestamptz IS NOT NULL AND (data->>'acceptedAt')::timestamptz = accepted_at);
-- Hash-possession lookup is SELECT-only; acceptance rechecks scope and the locked grant.
CREATE POLICY escalator_heartbeat_grant_lookup ON escalator_heartbeat_grant FOR SELECT
  USING (token_hash = nullif(current_setting('app.heartbeat_token_hash',true),''));
CREATE INDEX escalator_heartbeat_state_deadline ON escalator_heartbeat_state(workspace_id,deadline_at,probe_id);
CREATE INDEX escalator_heartbeat_receipt_retention ON escalator_heartbeat_receipt(workspace_id,accepted_at,id);
