CREATE TABLE escalator_secret (
  workspace_id text COLLATE "C" NOT NULL REFERENCES escalator_workspace(id),
  id text COLLATE "C" NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  envelope jsonb NOT NULL CHECK (
    jsonb_typeof(envelope) = 'object' AND
    envelope ?& ARRAY['version','keyId','nonce','ciphertext','tag'] AND
    jsonb_typeof(envelope->'version') = 'number' AND envelope->>'version' = '1' AND
    jsonb_typeof(envelope->'keyId') = 'string' AND
    jsonb_typeof(envelope->'nonce') = 'string' AND
    jsonb_typeof(envelope->'ciphertext') = 'string' AND
    jsonb_typeof(envelope->'tag') = 'string' AND
    octet_length(envelope::text) <= 100000
  ),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (workspace_id, id)
);
ALTER TABLE escalator_secret ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_secret FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_scope ON escalator_secret
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), ''))
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), ''));
