CREATE TABLE escalator_schedule (
  workspace_id text NOT NULL REFERENCES escalator_workspace(id),
  id text COLLATE "C" NOT NULL,
  data jsonb NOT NULL,
  service_id text NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, service_id) REFERENCES escalator_service(workspace_id, id),
  CHECK (jsonb_typeof(data) = 'object' AND NOT (data ? 'workspaceId')),
  CHECK (data->>'id' IS NOT NULL AND data->>'id' = id),
  CHECK (data->>'serviceId' IS NOT NULL AND service_id = data->>'serviceId'),
  CHECK ((data->>'version')::bigint IS NOT NULL AND version = (data->>'version')::bigint)
);

ALTER TABLE escalator_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_schedule FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_schedule_scope ON escalator_schedule
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

CREATE TABLE escalator_schedule_preview (
  workspace_id text NOT NULL REFERENCES escalator_workspace(id),
  id text COLLATE "C" NOT NULL,
  data jsonb NOT NULL,
  schedule_id text NOT NULL,
  service_id text NOT NULL,
  schedule_version bigint NOT NULL CHECK (schedule_version > 0),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, schedule_id) REFERENCES escalator_schedule(workspace_id, id),
  FOREIGN KEY (workspace_id, service_id) REFERENCES escalator_service(workspace_id, id),
  CHECK (jsonb_typeof(data) = 'object' AND NOT (data ? 'workspaceId')),
  CHECK (data->>'id' IS NOT NULL AND data->>'id' = id),
  CHECK (data->>'scheduleId' IS NOT NULL AND schedule_id = data->>'scheduleId'),
  CHECK (data->>'serviceId' IS NOT NULL AND service_id = data->>'serviceId'),
  CHECK ((data->>'scheduleVersion')::bigint IS NOT NULL AND schedule_version = (data->>'scheduleVersion')::bigint)
);

ALTER TABLE escalator_schedule_preview ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_schedule_preview FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_schedule_preview_scope ON escalator_schedule_preview
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

CREATE INDEX escalator_schedule_preview_parent ON escalator_schedule_preview(workspace_id,schedule_id,id);

CREATE TABLE escalator_policy (
  workspace_id text NOT NULL REFERENCES escalator_workspace(id),
  id text COLLATE "C" NOT NULL,
  data jsonb NOT NULL,
  service_id text NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  primary_schedule_id text NOT NULL,
  peer_schedule_id text NOT NULL,
  primary_preview_id text,
  peer_preview_id text,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, service_id) REFERENCES escalator_service(workspace_id, id),
  FOREIGN KEY (workspace_id, primary_schedule_id) REFERENCES escalator_schedule(workspace_id, id),
  FOREIGN KEY (workspace_id, peer_schedule_id) REFERENCES escalator_schedule(workspace_id, id),
  FOREIGN KEY (workspace_id, primary_preview_id) REFERENCES escalator_schedule_preview(workspace_id, id),
  FOREIGN KEY (workspace_id, peer_preview_id) REFERENCES escalator_schedule_preview(workspace_id, id),
  CHECK (jsonb_typeof(data) = 'object' AND NOT (data ? 'workspaceId')),
  CHECK (data->>'id' IS NOT NULL AND data->>'id' = id),
  CHECK (data->>'serviceId' IS NOT NULL AND service_id = data->>'serviceId'),
  CHECK ((data->>'version')::bigint IS NOT NULL AND version = (data->>'version')::bigint),
  CHECK (data->>'primaryScheduleId' IS NOT NULL AND primary_schedule_id = data->>'primaryScheduleId'),
  CHECK (data->>'peerScheduleId' IS NOT NULL AND peer_schedule_id = data->>'peerScheduleId'),
  CHECK (primary_preview_id IS NOT DISTINCT FROM (data->>'primaryPreviewId')),
  CHECK (peer_preview_id IS NOT DISTINCT FROM (data->>'peerPreviewId'))
);

ALTER TABLE escalator_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_policy FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_policy_scope ON escalator_policy
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

CREATE TABLE escalator_contact (
  workspace_id text NOT NULL REFERENCES escalator_workspace(id),
  id text COLLATE "C" NOT NULL,
  data jsonb NOT NULL,
  responder_id text NOT NULL,
  secret_id text NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, responder_id) REFERENCES escalator_responder(workspace_id, id),
  FOREIGN KEY (workspace_id, secret_id) REFERENCES escalator_secret(workspace_id, id),
  CHECK (jsonb_typeof(data) = 'object' AND NOT (data ? 'workspaceId')),
  CHECK (data->>'id' IS NOT NULL AND data->>'id' = id),
  CHECK (data->>'responderId' IS NOT NULL AND responder_id = data->>'responderId'),
  CHECK (data->>'secretId' IS NOT NULL AND secret_id = data->>'secretId'),
  CHECK ((data->>'version')::bigint IS NOT NULL AND version = (data->>'version')::bigint)
);

ALTER TABLE escalator_contact ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_contact FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_contact_scope ON escalator_contact
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

CREATE INDEX escalator_contact_parent ON escalator_contact(workspace_id,responder_id,id);

CREATE TABLE escalator_availability (
  workspace_id text NOT NULL REFERENCES escalator_workspace(id),
  id text COLLATE "C" NOT NULL,
  data jsonb NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, id) REFERENCES escalator_responder(workspace_id, id),
  CHECK (jsonb_typeof(data) = 'object' AND NOT (data ? 'workspaceId')),
  CHECK (data->>'id' IS NOT NULL AND data->>'id' = id),
  CHECK ((data->>'version')::bigint IS NOT NULL AND version = (data->>'version')::bigint)
);

ALTER TABLE escalator_availability ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_availability FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_availability_scope ON escalator_availability
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
