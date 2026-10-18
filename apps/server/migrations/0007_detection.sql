CREATE TABLE escalator_detection_binding (
  workspace_id text NOT NULL REFERENCES escalator_workspace(id),
  id text COLLATE "C" NOT NULL,
  service_id text NOT NULL,
  environment_id text NOT NULL,
  policy_id text,
  version bigint NOT NULL CHECK (version > 0),
  data jsonb NOT NULL,
  PRIMARY KEY (workspace_id,id),
  FOREIGN KEY (workspace_id,service_id) REFERENCES escalator_service(workspace_id,id),
  FOREIGN KEY (workspace_id,environment_id) REFERENCES escalator_environment(workspace_id,id),
  FOREIGN KEY (workspace_id,policy_id) REFERENCES escalator_policy(workspace_id,id),
  UNIQUE (workspace_id,service_id,environment_id),
  CHECK ((data->>'version')::bigint IS NOT NULL AND (data->>'version')::bigint = version),
  CHECK (jsonb_typeof(data) = 'object' AND NOT (data ? 'workspaceId')),
  CHECK (data->>'id' IS NOT NULL AND data->>'id' = id),
  CHECK (data->>'serviceId' IS NOT NULL AND data->>'serviceId' = service_id),
  CHECK (data->>'environmentId' IS NOT NULL AND data->>'environmentId' = environment_id),
  CHECK (policy_id IS NOT DISTINCT FROM (data->>'policyId'))
);
ALTER TABLE escalator_detection_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_detection_binding FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_detection_binding_scope ON escalator_detection_binding
  USING (workspace_id = current_setting('app.workspace_id',true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id',true));

CREATE TABLE escalator_detection_group (
  workspace_id text NOT NULL REFERENCES escalator_workspace(id),
  id text COLLATE "C" NOT NULL,
  service_id text NOT NULL,
  environment_id text NOT NULL,
  incident_id text,
  revision bigint NOT NULL CHECK (revision > 0),
  data jsonb NOT NULL,
  PRIMARY KEY (workspace_id,id),
  FOREIGN KEY (workspace_id,service_id) REFERENCES escalator_service(workspace_id,id),
  FOREIGN KEY (workspace_id,environment_id) REFERENCES escalator_environment(workspace_id,id),
  FOREIGN KEY (workspace_id,incident_id) REFERENCES escalator_incident(workspace_id,id),
  CHECK ((data->>'revision')::bigint IS NOT NULL AND (data->>'revision')::bigint = revision),
  CHECK (jsonb_typeof(data) = 'object' AND NOT (data ? 'workspaceId')),
  CHECK (data->>'id' IS NOT NULL AND data->>'id' = id),
  CHECK (data->>'serviceId' IS NOT NULL AND data->>'serviceId' = service_id),
  CHECK (data->>'environmentId' IS NOT NULL AND data->>'environmentId' = environment_id),
  CHECK (incident_id IS NOT DISTINCT FROM (data->>'incidentId'))
);
ALTER TABLE escalator_detection_group ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_detection_group FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_detection_group_scope ON escalator_detection_group
  USING (workspace_id = current_setting('app.workspace_id',true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id',true));

CREATE TABLE escalator_detection_alert (
  workspace_id text NOT NULL REFERENCES escalator_workspace(id),
  id text COLLATE "C" NOT NULL,
  source_id text NOT NULL,
  group_key text NOT NULL,
  incident_id text,
  last_signal_id text NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (workspace_id,id),
  FOREIGN KEY (workspace_id,source_id) REFERENCES escalator_signal_source(workspace_id,id),
  FOREIGN KEY (workspace_id,group_key) REFERENCES escalator_detection_group(workspace_id,id),
  FOREIGN KEY (workspace_id,incident_id) REFERENCES escalator_incident(workspace_id,id),
  FOREIGN KEY (workspace_id,last_signal_id) REFERENCES escalator_signal_event(workspace_id,id),
  CHECK (jsonb_typeof(data) = 'object' AND NOT (data ? 'workspaceId')),
  CHECK (data->>'id' IS NOT NULL AND data->>'id' = id),
  CHECK (data->>'sourceId' IS NOT NULL AND data->>'sourceId' = source_id),
  CHECK (data->>'groupKey' IS NOT NULL AND data->>'groupKey' = group_key),
  CHECK (incident_id IS NOT DISTINCT FROM (data->>'incidentId')),
  CHECK (data->>'lastSignalId' IS NOT NULL AND data->>'lastSignalId' = last_signal_id)
);
ALTER TABLE escalator_detection_alert ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_detection_alert FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_detection_alert_scope ON escalator_detection_alert
  USING (workspace_id = current_setting('app.workspace_id',true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id',true));

CREATE TABLE escalator_detection_processed (
  workspace_id text NOT NULL REFERENCES escalator_workspace(id),
  id text COLLATE "C" NOT NULL,
  source_id text NOT NULL,
  incident_id text,
  recorded_at timestamptz NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (workspace_id,id),
  FOREIGN KEY (workspace_id,id) REFERENCES escalator_signal_event(workspace_id,id),
  FOREIGN KEY (workspace_id,source_id) REFERENCES escalator_signal_source(workspace_id,id),
  FOREIGN KEY (workspace_id,incident_id) REFERENCES escalator_incident(workspace_id,id),
  CHECK ((data->>'recordedAt')::timestamptz IS NOT NULL AND (data->>'recordedAt')::timestamptz = recorded_at),
  CHECK (jsonb_typeof(data) = 'object' AND NOT (data ? 'workspaceId')),
  CHECK (data->>'id' IS NOT NULL AND data->>'id' = id),
  CHECK (data->>'sourceId' IS NOT NULL AND data->>'sourceId' = source_id),
  CHECK (incident_id IS NOT DISTINCT FROM (data->>'incidentId'))
);
ALTER TABLE escalator_detection_processed ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_detection_processed FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_detection_processed_scope ON escalator_detection_processed
  USING (workspace_id = current_setting('app.workspace_id',true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id',true));

CREATE INDEX escalator_detection_alert_incident ON escalator_detection_alert(workspace_id,incident_id,id);
CREATE INDEX escalator_detection_processed_recorded ON escalator_detection_processed(workspace_id,recorded_at,id);
