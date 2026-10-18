CREATE TABLE escalator_incident (
  workspace_id text NOT NULL REFERENCES escalator_workspace(id),
  id text COLLATE "C" NOT NULL,
  data jsonb NOT NULL,
  service_id text NOT NULL,
  environment_id text NOT NULL,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, service_id) REFERENCES escalator_service(workspace_id, id),
  FOREIGN KEY (workspace_id, environment_id) REFERENCES escalator_environment(workspace_id, id),
  CHECK (jsonb_typeof(data) = 'object' AND NOT (data ? 'workspaceId')),
  CHECK (data->>'id' IS NOT NULL AND data->>'id' = id),
  CHECK (data->>'serviceId' IS NOT NULL AND service_id = data->>'serviceId'),
  CHECK (data->>'environmentId' IS NOT NULL AND environment_id = data->>'environmentId')
);

ALTER TABLE escalator_incident ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_incident FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_incident_scope ON escalator_incident
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

CREATE TABLE escalator_page (
  workspace_id text NOT NULL REFERENCES escalator_workspace(id),
  id text COLLATE "C" NOT NULL,
  data jsonb NOT NULL,
  incident_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, incident_id) REFERENCES escalator_incident(workspace_id, id),
  CHECK (jsonb_typeof(data) = 'object' AND NOT (data ? 'workspaceId')),
  CHECK (data->>'id' IS NOT NULL AND data->>'id' = id),
  CHECK (data->>'incidentId' IS NOT NULL AND incident_id = data->>'incidentId'),
  CHECK ((data->>'revision')::bigint IS NOT NULL AND revision = (data->>'revision')::bigint)
);

ALTER TABLE escalator_page ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_page FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_page_scope ON escalator_page
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

CREATE TABLE escalator_page_step (
  workspace_id text NOT NULL REFERENCES escalator_workspace(id),
  id text COLLATE "C" NOT NULL,
  data jsonb NOT NULL,
  page_id text NOT NULL,
  logical_step_id text NOT NULL,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, page_id) REFERENCES escalator_page(workspace_id, id),
  UNIQUE (workspace_id, page_id, logical_step_id),
  UNIQUE (workspace_id, page_id, id),
  CHECK (jsonb_typeof(data) = 'object' AND NOT (data ? 'workspaceId')),
  CHECK (data->>'id' IS NOT NULL AND data->>'id' = id),
  CHECK (data->>'pageId' IS NOT NULL AND page_id = data->>'pageId'),
  CHECK (data->>'logicalStepId' IS NOT NULL AND logical_step_id = data->>'logicalStepId')
);

ALTER TABLE escalator_page_step ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_page_step FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_page_step_scope ON escalator_page_step
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

CREATE TABLE escalator_delivery (
  workspace_id text NOT NULL REFERENCES escalator_workspace(id),
  id text COLLATE "C" NOT NULL,
  data jsonb NOT NULL,
  page_id text NOT NULL,
  step_id text NOT NULL,
  recipient_id text NOT NULL,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, page_id, step_id) REFERENCES escalator_page_step(workspace_id, page_id, id),
  FOREIGN KEY (workspace_id, recipient_id) REFERENCES escalator_responder(workspace_id, id),
  UNIQUE (workspace_id, page_id, step_id, recipient_id),
  CHECK (jsonb_typeof(data) = 'object' AND NOT (data ? 'workspaceId')),
  CHECK (data->>'id' IS NOT NULL AND data->>'id' = id),
  CHECK (data->>'pageId' IS NOT NULL AND page_id = data->>'pageId'),
  CHECK (data->>'stepId' IS NOT NULL AND step_id = data->>'stepId'),
  CHECK (data->>'recipientId' IS NOT NULL AND recipient_id = data->>'recipientId')
);

ALTER TABLE escalator_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_delivery FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_delivery_scope ON escalator_delivery
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

CREATE TABLE escalator_delivery_attempt (
  workspace_id text NOT NULL REFERENCES escalator_workspace(id),
  id text COLLATE "C" NOT NULL,
  data jsonb NOT NULL,
  delivery_id text NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, delivery_id) REFERENCES escalator_delivery(workspace_id, id),
  UNIQUE (workspace_id, delivery_id, attempt),
  CHECK (jsonb_typeof(data) = 'object' AND NOT (data ? 'workspaceId')),
  CHECK (data->>'id' IS NOT NULL AND data->>'id' = id),
  CHECK (data->>'deliveryId' IS NOT NULL AND delivery_id = data->>'deliveryId'),
  CHECK ((data->>'attempt')::bigint IS NOT NULL AND attempt = (data->>'attempt')::bigint)
);

ALTER TABLE escalator_delivery_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_delivery_attempt FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_delivery_attempt_scope ON escalator_delivery_attempt
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

CREATE TABLE escalator_ack_grant (
  workspace_id text NOT NULL REFERENCES escalator_workspace(id),
  id text COLLATE "C" NOT NULL,
  data jsonb NOT NULL,
  page_id text NOT NULL,
  recipient_id text NOT NULL,
  attempt_id text NOT NULL,
  token_digest text NOT NULL CHECK (token_digest ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, page_id) REFERENCES escalator_page(workspace_id, id),
  FOREIGN KEY (workspace_id, recipient_id) REFERENCES escalator_responder(workspace_id, id),
  FOREIGN KEY (workspace_id, attempt_id) REFERENCES escalator_delivery_attempt(workspace_id, id),
  UNIQUE (workspace_id, token_digest),
  CHECK (jsonb_typeof(data) = 'object' AND NOT (data ? 'workspaceId')),
  CHECK (data->>'id' IS NOT NULL AND data->>'id' = id),
  CHECK (data->>'pageId' IS NOT NULL AND page_id = data->>'pageId'),
  CHECK (data->>'recipientId' IS NOT NULL AND recipient_id = data->>'recipientId'),
  CHECK (data->>'attemptId' IS NOT NULL AND attempt_id = data->>'attemptId'),
  CHECK (data->>'tokenDigest' IS NOT NULL AND token_digest = data->>'tokenDigest'),
  CHECK ((data->>'expiresAt')::timestamptz IS NOT NULL AND expires_at = (data->>'expiresAt')::timestamptz)
);

ALTER TABLE escalator_ack_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_ack_grant FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_ack_grant_scope ON escalator_ack_grant
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
