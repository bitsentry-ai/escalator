ALTER TABLE escalator_secret ADD COLUMN purpose text NOT NULL DEFAULT 'provider' CHECK (purpose IN ('provider','authentication'));
CREATE TABLE escalator_account (
  workspace_id text COLLATE "C" NOT NULL REFERENCES escalator_workspace(id),
  id text COLLATE "C" NOT NULL,
  login text COLLATE "C" NOT NULL CHECK (login ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
  password_hash text NOT NULL CHECK (length(password_hash) BETWEEN 1 AND 512),
  enabled boolean NOT NULL DEFAULT true,
  auth_version integer NOT NULL DEFAULT 1 CHECK (auth_version > 0),
  totp_secret_id text COLLATE "C",
  totp_pending_secret_id text COLLATE "C",
  totp_pending_expires_at timestamptz,
  totp_last_step bigint,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, login),
  FOREIGN KEY (workspace_id, id) REFERENCES escalator_responder(workspace_id, id),
  FOREIGN KEY (workspace_id, totp_secret_id) REFERENCES escalator_secret(workspace_id, id),
  FOREIGN KEY (workspace_id, totp_pending_secret_id) REFERENCES escalator_secret(workspace_id, id),
  CHECK ((totp_pending_secret_id IS NULL) = (totp_pending_expires_at IS NULL)),
  CHECK (totp_last_step IS NULL OR totp_last_step BETWEEN 0 AND 9007199254740991)
);
CREATE TABLE escalator_auth_token (
  workspace_id text COLLATE "C" NOT NULL REFERENCES escalator_workspace(id),
  id text COLLATE "C" NOT NULL,
  digest text COLLATE "C" NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  purpose text NOT NULL CHECK (purpose IN ('bootstrap','invite','recovery')),
  role text NOT NULL CHECK (role IN ('administrator','responder','viewer')),
  account_id text COLLATE "C",
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, digest),
  FOREIGN KEY (workspace_id, account_id) REFERENCES escalator_account(workspace_id, id),
  CHECK ((purpose = 'recovery') = (account_id IS NOT NULL)),
  CHECK (purpose <> 'bootstrap' OR role = 'administrator')
);
CREATE UNIQUE INDEX escalator_bootstrap_once ON escalator_auth_token(workspace_id) WHERE purpose='bootstrap';
CREATE TABLE escalator_recovery_code (
  workspace_id text COLLATE "C" NOT NULL,
  account_id text COLLATE "C" NOT NULL,
  digest text COLLATE "C" NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  consumed_at timestamptz,
  PRIMARY KEY (workspace_id, account_id, digest),
  FOREIGN KEY (workspace_id, account_id) REFERENCES escalator_account(workspace_id, id)
);
CREATE TABLE escalator_session (
  workspace_id text COLLATE "C" NOT NULL REFERENCES escalator_workspace(id),
  sid_digest text COLLATE "C" NOT NULL CHECK (sid_digest ~ '^[a-f0-9]{64}$'),
  data jsonb NOT NULL CHECK (jsonb_typeof(data)='object' AND octet_length(data::text)<=16384),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (workspace_id, sid_digest)
);
CREATE INDEX escalator_session_expiry ON escalator_session(workspace_id, expires_at);
CREATE TABLE escalator_auth_rate (
  workspace_id text COLLATE "C" NOT NULL REFERENCES escalator_workspace(id),
  bucket_digest text COLLATE "C" NOT NULL CHECK (bucket_digest ~ '^[a-f0-9]{64}$'),
  window_start timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts>0),
  PRIMARY KEY (workspace_id, bucket_digest)
);
CREATE INDEX escalator_auth_rate_window ON escalator_auth_rate(workspace_id, window_start);
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['escalator_account','escalator_auth_token','escalator_recovery_code','escalator_session','escalator_auth_rate'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY workspace_scope ON %I USING (workspace_id = nullif(current_setting(''app.workspace_id'', true), '''')) WITH CHECK (workspace_id = nullif(current_setting(''app.workspace_id'', true), ''''))', table_name);
  END LOOP;
END $$;
