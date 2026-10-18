CREATE TABLE escalator_workspace (
  id text COLLATE "C" PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (updated_at >= created_at)
);
CREATE TABLE escalator_service (
  workspace_id text NOT NULL REFERENCES escalator_workspace(id),
  id text COLLATE "C" NOT NULL,
  name text NOT NULL,
  key text NOT NULL,
  owning_team text NOT NULL,
  enabled boolean NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, key),
  CHECK (updated_at >= created_at)
);
CREATE TABLE escalator_environment (
  workspace_id text NOT NULL REFERENCES escalator_workspace(id),
  id text COLLATE "C" NOT NULL,
  name text NOT NULL,
  key text NOT NULL,
  is_production boolean NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, key),
  CHECK (updated_at >= created_at)
);
CREATE TABLE escalator_responder (
  workspace_id text NOT NULL REFERENCES escalator_workspace(id),
  id text COLLATE "C" NOT NULL,
  host_user_id text COLLATE "C" NOT NULL,
  display_name text NOT NULL,
  time_zone text NOT NULL,
  role text NOT NULL CHECK (role IN ('administrator', 'responder', 'viewer')),
  enabled boolean NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, host_user_id),
  CHECK (updated_at >= created_at)
);
CREATE TABLE escalator_audit (
  workspace_id text NOT NULL REFERENCES escalator_workspace(id),
  id text COLLATE "C" NOT NULL,
  actor jsonb NOT NULL,
  action text NOT NULL,
  subject_type text NOT NULL,
  subject_id text COLLATE "C" NOT NULL,
  recorded_at timestamptz NOT NULL,
  metadata jsonb NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
CREATE TABLE escalator_job (
  workspace_id text NOT NULL REFERENCES escalator_workspace(id),
  id text COLLATE "C" NOT NULL,
  kind text NOT NULL,
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL,
  due_at timestamptz NOT NULL,
  priority integer NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','completed','cancelled','failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_token text,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, kind, idempotency_key),
  CHECK ((state = 'running' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL) OR (state <> 'running' AND lease_token IS NULL AND lease_expires_at IS NULL))
);
CREATE INDEX escalator_job_due ON escalator_job (workspace_id, due_at, priority DESC) WHERE state IN ('pending','running');
CREATE TABLE escalator_outbox (
  workspace_id text NOT NULL REFERENCES escalator_workspace(id),
  id text COLLATE "C" NOT NULL,
  kind text NOT NULL,
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL,
  due_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','completed','cancelled','failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_token text,
  lease_expires_at timestamptz,
  outcome text CHECK (outcome IN ('accepted','rejected','unknown')),
  provider_receipt text,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, kind, idempotency_key),
  CHECK ((state = 'running' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL) OR (state <> 'running' AND lease_token IS NULL AND lease_expires_at IS NULL))
);
CREATE INDEX escalator_outbox_due ON escalator_outbox (workspace_id, due_at) WHERE state IN ('pending','running');

ALTER TABLE escalator_workspace ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_workspace FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_scope ON escalator_workspace
  USING (id = nullif(current_setting('app.workspace_id', true), ''))
  WITH CHECK (id = nullif(current_setting('app.workspace_id', true), ''));
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['escalator_service','escalator_environment','escalator_responder','escalator_audit','escalator_job','escalator_outbox'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY workspace_scope ON %I USING (workspace_id = nullif(current_setting(''app.workspace_id'', true), '''')) WITH CHECK (workspace_id = nullif(current_setting(''app.workspace_id'', true), ''''))', table_name);
  END LOOP;
END $$;
