-- Normalized receipt payload accounting. Physical/index/WAL/audit storage is separate.
-- Authorized migration role must bypass RLS; fail if policies would filter a backfill.
SET LOCAL row_security=off;
-- Keep workspace creation behind the backfill and initializer installation.
LOCK TABLE escalator_workspace IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE escalator_retention_policy (
 workspace_id text PRIMARY KEY REFERENCES escalator_workspace(id),
 days integer NOT NULL CHECK(days BETWEEN 1 AND 365),
 max_bytes bigint NOT NULL CHECK(max_bytes BETWEEN 1048576 AND 1099511627776),
 version bigint NOT NULL CHECK(version BETWEEN 1 AND 9007199254740991),
 updated_at timestamptz NOT NULL
);
CREATE TABLE escalator_replay_usage (
 workspace_id text PRIMARY KEY REFERENCES escalator_workspace(id),
 payload_bytes bigint NOT NULL CHECK(payload_bytes BETWEEN 0 AND 9007199254740991),
 updated_at timestamptz NOT NULL
);
CREATE TABLE escalator_signal_tombstone (
 workspace_id text NOT NULL REFERENCES escalator_workspace(id),
 signal_id text COLLATE "C" NOT NULL,
 source_id text COLLATE "C" NOT NULL,
 retained_at timestamptz NOT NULL,
 PRIMARY KEY(workspace_id,signal_id),
 FOREIGN KEY(workspace_id,source_id) REFERENCES escalator_signal_source(workspace_id,id)
);
ALTER TABLE escalator_retention_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_retention_policy FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_retention_policy_scope ON escalator_retention_policy
 USING(workspace_id=current_setting('app.workspace_id',true)) WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
ALTER TABLE escalator_replay_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_replay_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_replay_usage_scope ON escalator_replay_usage
 USING(workspace_id=current_setting('app.workspace_id',true)) WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
ALTER TABLE escalator_signal_tombstone ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_signal_tombstone FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_signal_tombstone_scope ON escalator_signal_tombstone
 USING(workspace_id=current_setting('app.workspace_id',true)) WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
ALTER TABLE escalator_signal_event ADD COLUMN payload_bytes bigint NOT NULL DEFAULT 0;
ALTER TABLE escalator_probe_result ADD COLUMN payload_bytes bigint NOT NULL DEFAULT 0;
ALTER TABLE escalator_metric_observation ADD COLUMN payload_bytes bigint NOT NULL DEFAULT 0;
UPDATE escalator_signal_event SET payload_bytes=octet_length(data::text);
UPDATE escalator_probe_result SET payload_bytes=octet_length(data::text);
UPDATE escalator_metric_observation SET payload_bytes=octet_length(data::text);
ALTER TABLE escalator_signal_event ADD CHECK(payload_bytes BETWEEN 1 AND 9007199254740991);
ALTER TABLE escalator_probe_result ADD CHECK(payload_bytes BETWEEN 1 AND 9007199254740991);
ALTER TABLE escalator_metric_observation ADD CHECK(payload_bytes BETWEEN 1 AND 9007199254740991);
INSERT INTO escalator_replay_usage(workspace_id,payload_bytes,updated_at)
SELECT w.id, COALESCE(sum(r.payload_bytes),0),date_trunc('milliseconds',clock_timestamp())
FROM escalator_workspace w LEFT JOIN (
 SELECT workspace_id,payload_bytes FROM escalator_signal_event
 UNION ALL SELECT workspace_id,payload_bytes FROM escalator_probe_result
 UNION ALL SELECT workspace_id,payload_bytes FROM escalator_metric_observation
) r ON r.workspace_id=w.id GROUP BY w.id;

CREATE FUNCTION escalator_initialize_replay_usage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 EXECUTE format('INSERT INTO %I.escalator_replay_usage(workspace_id,payload_bytes,updated_at) VALUES ($1,0,date_trunc(''milliseconds'',clock_timestamp()))',TG_TABLE_SCHEMA) USING NEW.id;
 RETURN NULL;
END;
$$;
CREATE TRIGGER escalator_workspace_replay_usage AFTER INSERT ON escalator_workspace
 FOR EACH ROW EXECUTE FUNCTION escalator_initialize_replay_usage();

CREATE FUNCTION escalator_measure_replay_payload() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.workspace_id<>OLD.workspace_id OR NEW.id<>OLD.id) THEN
  RAISE EXCEPTION 'Replay receipt identity is immutable';
 END IF;
 NEW.payload_bytes:=octet_length(NEW.data::text);
 RETURN NEW;
END;
$$;
CREATE FUNCTION escalator_account_replay_payload() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE scope_id text; delta bigint; affected integer;
BEGIN
 IF TG_OP='DELETE' THEN scope_id:=OLD.workspace_id; delta:=-OLD.payload_bytes;
 ELSIF TG_OP='UPDATE' THEN scope_id:=NEW.workspace_id; delta:=NEW.payload_bytes-OLD.payload_bytes;
 ELSE scope_id:=NEW.workspace_id; delta:=NEW.payload_bytes; END IF;
 IF delta<>0 THEN
  -- Callers lock one source before this accounting row and never a second source afterward.
  EXECUTE format('UPDATE %I.escalator_replay_usage SET payload_bytes=payload_bytes+$2,updated_at=date_trunc(''milliseconds'',clock_timestamp()) WHERE workspace_id=$1',TG_TABLE_SCHEMA) USING scope_id,delta;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected<>1 THEN RAISE EXCEPTION 'Replay accounting row unavailable'; END IF;
 END IF;
 RETURN NULL;
END;
$$;
CREATE TRIGGER escalator_signal_measure_payload BEFORE INSERT OR UPDATE ON escalator_signal_event
 FOR EACH ROW EXECUTE FUNCTION escalator_measure_replay_payload();
CREATE TRIGGER escalator_probe_measure_payload BEFORE INSERT OR UPDATE ON escalator_probe_result
 FOR EACH ROW EXECUTE FUNCTION escalator_measure_replay_payload();
CREATE TRIGGER escalator_metric_measure_payload BEFORE INSERT OR UPDATE ON escalator_metric_observation
 FOR EACH ROW EXECUTE FUNCTION escalator_measure_replay_payload();
CREATE TRIGGER escalator_signal_account_payload AFTER INSERT OR UPDATE OR DELETE ON escalator_signal_event
 FOR EACH ROW EXECUTE FUNCTION escalator_account_replay_payload();
CREATE TRIGGER escalator_probe_account_payload AFTER INSERT OR UPDATE OR DELETE ON escalator_probe_result
 FOR EACH ROW EXECUTE FUNCTION escalator_account_replay_payload();
CREATE TRIGGER escalator_metric_account_payload AFTER INSERT OR UPDATE OR DELETE ON escalator_metric_observation
 FOR EACH ROW EXECUTE FUNCTION escalator_account_replay_payload();

CREATE FUNCTION escalator_signal_retention_dedupe() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE already_retained boolean;
BEGIN
 EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.escalator_signal_tombstone WHERE workspace_id=$1 AND signal_id=$2)',TG_TABLE_SCHEMA)
 INTO already_retained USING NEW.workspace_id,NEW.id;
 IF already_retained THEN RETURN NULL; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER escalator_signal_retention_dedupe BEFORE INSERT ON escalator_signal_event
 FOR EACH ROW EXECUTE FUNCTION escalator_signal_retention_dedupe();
CREATE INDEX escalator_signal_tombstone_source ON escalator_signal_tombstone(workspace_id,source_id,signal_id);
