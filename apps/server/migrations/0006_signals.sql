CREATE TABLE escalator_signal_source (
  workspace_id text NOT NULL REFERENCES escalator_workspace(id),
  id text COLLATE "C" NOT NULL,
  service_id text NOT NULL,
  environment_id text NOT NULL,
  auth_secret_id text,
  version bigint NOT NULL CHECK (version > 0),
  data jsonb NOT NULL,
  PRIMARY KEY (workspace_id,id),
  FOREIGN KEY (workspace_id,service_id) REFERENCES escalator_service(workspace_id,id),
  FOREIGN KEY (workspace_id,environment_id) REFERENCES escalator_environment(workspace_id,id),
  FOREIGN KEY (workspace_id,auth_secret_id) REFERENCES escalator_secret(workspace_id,id),
  CHECK (jsonb_typeof(data) = 'object' AND NOT (data ? 'workspaceId')),
  CHECK (data->>'id' IS NOT NULL AND data->>'id' = id),
  CHECK (data->>'serviceId' IS NOT NULL AND data->>'serviceId' = service_id),
  CHECK (data->>'environmentId' IS NOT NULL AND data->>'environmentId' = environment_id),
  CHECK (auth_secret_id IS NOT DISTINCT FROM (data->>'authSecretId')),
  CHECK ((data->>'version')::bigint IS NOT NULL AND (data->>'version')::bigint = version)
);
ALTER TABLE escalator_signal_source ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_signal_source FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_signal_source_scope ON escalator_signal_source
  USING (workspace_id = current_setting('app.workspace_id',true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id',true));

CREATE TABLE escalator_signal_token (
  workspace_id text NOT NULL REFERENCES escalator_workspace(id),
  id text COLLATE "C" NOT NULL,
  source_id text NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  data jsonb NOT NULL,
  PRIMARY KEY (workspace_id,id),
  FOREIGN KEY (workspace_id,source_id) REFERENCES escalator_signal_source(workspace_id,id),
  CHECK (jsonb_typeof(data) = 'object' AND NOT (data ? 'workspaceId')),
  CHECK (data->>'id' IS NOT NULL AND data->>'id' = id),
  CHECK (data->>'sourceId' IS NOT NULL AND data->>'sourceId' = source_id),
  CHECK (data->>'tokenHash' IS NOT NULL AND data->>'tokenHash' = token_hash)
);
ALTER TABLE escalator_signal_token ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_signal_token FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_signal_token_scope ON escalator_signal_token
  USING (workspace_id = current_setting('app.workspace_id',true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id',true));
-- Authentication only: possession of an exact random-token digest permits one
-- SELECT, never cross-workspace INSERT/UPDATE. The adapter projects only IDs and
-- rechecks the full grant under its source lock before accepting an event.
CREATE POLICY escalator_signal_token_lookup ON escalator_signal_token FOR SELECT
  USING (token_hash = nullif(current_setting('app.signal_token_hash',true),''));
CREATE INDEX escalator_signal_token_source ON escalator_signal_token(workspace_id,source_id,id);

CREATE TABLE escalator_signal_event (
  workspace_id text NOT NULL REFERENCES escalator_workspace(id),
  id text COLLATE "C" NOT NULL,
  source_id text NOT NULL,
  event_id text NOT NULL,
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (workspace_id,id),
  UNIQUE (workspace_id,source_id,event_id),
  FOREIGN KEY (workspace_id,source_id) REFERENCES escalator_signal_source(workspace_id,id),
  CHECK (jsonb_typeof(data) = 'object' AND NOT (data ? 'workspaceId')),
  CHECK (data->>'id' IS NOT NULL AND data->>'id' = id),
  CHECK (data->>'sourceId' IS NOT NULL AND data->>'sourceId' = source_id),
  CHECK (data->>'eventId' IS NOT NULL AND data->>'eventId' = event_id),
  CHECK ((data->>'observedAt')::timestamptz IS NOT NULL AND (data->>'observedAt')::timestamptz = observed_at),
  CHECK ((data->>'receivedAt')::timestamptz IS NOT NULL AND (data->>'receivedAt')::timestamptz = received_at)
);
ALTER TABLE escalator_signal_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_signal_event FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_signal_event_scope ON escalator_signal_event
  USING (workspace_id = current_setting('app.workspace_id',true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id',true));
CREATE INDEX escalator_signal_event_received ON escalator_signal_event(workspace_id,received_at,id);
CREATE INDEX escalator_signal_event_observed ON escalator_signal_event(workspace_id,source_id,observed_at,id);
