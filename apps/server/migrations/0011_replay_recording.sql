-- Capture existing configuration only from this migration onward. Never backdate availability.
-- Fail rather than silently backfilling only rows visible through RLS. Migration role must bypass RLS.
SET LOCAL row_security = off;
CREATE TABLE escalator_source_version (
 workspace_id text NOT NULL REFERENCES escalator_workspace(id),
 source_id text COLLATE "C" NOT NULL,
 version bigint NOT NULL CHECK(version>0),
 effective_at timestamptz NOT NULL,
 recorded_at timestamptz NOT NULL,
 origin text NOT NULL CHECK(origin IN ('capture','change')),
 data jsonb NOT NULL,
 PRIMARY KEY(workspace_id,source_id,version),
 FOREIGN KEY(workspace_id,source_id) REFERENCES escalator_signal_source(workspace_id,id),
 CHECK(jsonb_typeof(data)='object' AND NOT(data ? 'workspaceId')),
 CHECK(data->>'id' IS NOT NULL AND data->>'id'=source_id),
 CHECK(data->>'version' IS NOT NULL AND (data->>'version')::bigint=version)
);
CREATE TABLE escalator_probe_version (
 workspace_id text NOT NULL REFERENCES escalator_workspace(id),
 probe_id text COLLATE "C" NOT NULL,
 version bigint NOT NULL CHECK(version>0),
 effective_at timestamptz NOT NULL,
 recorded_at timestamptz NOT NULL,
 origin text NOT NULL CHECK(origin IN ('capture','change')),
 data jsonb NOT NULL,
 PRIMARY KEY(workspace_id,probe_id,version),
 FOREIGN KEY(workspace_id,probe_id) REFERENCES escalator_probe(workspace_id,id),
 CHECK(jsonb_typeof(data)='object' AND NOT(data ? 'workspaceId')),
 CHECK(data->>'id' IS NOT NULL AND data->>'id'=probe_id),
 CHECK(data->>'version' IS NOT NULL AND (data->>'version')::bigint=version)
);
ALTER TABLE escalator_source_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_source_version FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_source_version_scope ON escalator_source_version
 USING(workspace_id=current_setting('app.workspace_id',true))
 WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
ALTER TABLE escalator_probe_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_probe_version FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_probe_version_scope ON escalator_probe_version
 USING(workspace_id=current_setting('app.workspace_id',true))
 WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
ALTER TABLE escalator_metric_version ADD COLUMN effective_at timestamptz;
ALTER TABLE escalator_metric_version ADD COLUMN recorded_at timestamptz;
ALTER TABLE escalator_metric_version ADD COLUMN origin text;
ALTER TABLE escalator_metric_version ADD CHECK(
 (effective_at IS NULL AND recorded_at IS NULL AND origin IS NULL) OR
 (effective_at IS NOT NULL AND recorded_at IS NOT NULL AND origin IS NOT NULL AND origin IN ('capture','change'))
);
ALTER TABLE escalator_signal_event ADD COLUMN source_version bigint;
ALTER TABLE escalator_signal_event ADD FOREIGN KEY(workspace_id,source_id,source_version)
 REFERENCES escalator_source_version(workspace_id,source_id,version);
ALTER TABLE escalator_probe_result ADD COLUMN probe_version bigint;
ALTER TABLE escalator_probe_result ADD FOREIGN KEY(workspace_id,probe_id,probe_version)
 REFERENCES escalator_probe_version(workspace_id,probe_id,version);
ALTER TABLE escalator_probe_result ADD COLUMN received_at timestamptz;
ALTER TABLE escalator_probe_result ADD COLUMN scheduled_at timestamptz;

DO $$
DECLARE captured timestamptz := date_trunc('milliseconds',clock_timestamp());
BEGIN
 INSERT INTO escalator_source_version (workspace_id,source_id,version,effective_at,recorded_at,origin,data)
 SELECT workspace_id,id,version,captured,captured,'capture',data FROM escalator_signal_source;
 INSERT INTO escalator_probe_version (workspace_id,probe_id,version,effective_at,recorded_at,origin,data)
 SELECT workspace_id,id,version,captured,captured,'capture',data FROM escalator_probe;
 UPDATE escalator_metric_version v SET effective_at=captured,recorded_at=captured,origin='capture'
 FROM escalator_metric_monitor m
 WHERE v.workspace_id=m.workspace_id AND v.monitor_id=m.id AND v.version=m.version;
END;
$$;

CREATE FUNCTION escalator_record_configuration() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_table text; target_key text;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.workspace_id<>OLD.workspace_id OR NEW.id<>OLD.id THEN
   RAISE EXCEPTION 'Replay configuration identity is immutable';
  END IF;
  IF NEW.version=OLD.version AND NEW.data=OLD.data THEN RETURN NEW; END IF;
  IF NEW.version<=OLD.version THEN RAISE EXCEPTION 'Replay configuration revision must advance'; END IF;
 END IF;
 IF TG_TABLE_NAME='escalator_signal_source' THEN
  target_table:='escalator_source_version'; target_key:='source_id';
 ELSIF TG_TABLE_NAME='escalator_probe' THEN
  target_table:='escalator_probe_version'; target_key:='probe_id';
 ELSE RAISE EXCEPTION 'Unsupported replay configuration table'; END IF;
 -- Identifiers come only from this closed trigger table mapping; values remain bound.
 EXECUTE format('INSERT INTO %I.%I (workspace_id,%I,version,effective_at,recorded_at,origin,data) VALUES ($1,$2,$3,$4,$5,$6,$7)',TG_TABLE_SCHEMA,target_table,target_key)
 USING NEW.workspace_id,NEW.id,NEW.version,(NEW.data->>'updatedAt')::timestamptz,
       date_trunc('milliseconds',clock_timestamp()),'change',NEW.data;
 RETURN NEW;
END;
$$;
CREATE TRIGGER escalator_source_record_version AFTER INSERT OR UPDATE ON escalator_signal_source
 FOR EACH ROW EXECUTE FUNCTION escalator_record_configuration();
CREATE TRIGGER escalator_probe_record_version AFTER INSERT OR UPDATE ON escalator_probe
 FOR EACH ROW EXECUTE FUNCTION escalator_record_configuration();

CREATE FUNCTION escalator_record_metric_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.effective_at:=(NEW.data->>'updatedAt')::timestamptz;
 NEW.recorded_at:=date_trunc('milliseconds',clock_timestamp());
 NEW.origin:='change';
 RETURN NEW;
END;
$$;
CREATE TRIGGER escalator_metric_record_version BEFORE INSERT ON escalator_metric_version
 FOR EACH ROW EXECUTE FUNCTION escalator_record_metric_version();

CREATE FUNCTION escalator_record_signal_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 EXECUTE format('SELECT version FROM %I.escalator_signal_source WHERE workspace_id=$1 AND id=$2',TG_TABLE_SCHEMA)
 INTO NEW.source_version USING NEW.workspace_id,NEW.source_id;
 IF NEW.source_version IS NULL THEN RAISE EXCEPTION 'Signal source revision unavailable'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER escalator_signal_record_revision BEFORE INSERT ON escalator_signal_event
 FOR EACH ROW EXECUTE FUNCTION escalator_record_signal_revision();

CREATE FUNCTION escalator_record_probe_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE scheduled text;
BEGIN
 NEW.probe_version:=(NEW.data->>'probeVersion')::bigint;
 IF NEW.probe_version IS NULL THEN RAISE EXCEPTION 'Probe revision unavailable'; END IF;
 NEW.received_at:=date_trunc('milliseconds',clock_timestamp());
 NEW.scheduled_at:=NULL;
 -- Existing hosts omit metadata, so capture it from the durable job when identity agrees.
 EXECUTE format('SELECT payload->>''dueAt'' FROM %I.escalator_job WHERE workspace_id=$1 AND id=$2 AND kind=''probe.execute'' AND payload->>''probeId''=$3 AND payload->>''probeVersion''=$4',TG_TABLE_SCHEMA)
 INTO scheduled USING NEW.workspace_id,NEW.id,NEW.probe_id,NEW.data->>'probeVersion';
 IF scheduled IS NOT NULL THEN
  BEGIN NEW.scheduled_at:=scheduled::timestamptz;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN NEW.scheduled_at:=NULL;
  END;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER escalator_probe_record_receipt BEFORE INSERT ON escalator_probe_result
 FOR EACH ROW EXECUTE FUNCTION escalator_record_probe_receipt();
CREATE INDEX escalator_source_version_window ON escalator_source_version(workspace_id,source_id,effective_at,version);
CREATE INDEX escalator_probe_version_window ON escalator_probe_version(workspace_id,probe_id,effective_at,version);
CREATE INDEX escalator_metric_version_window ON escalator_metric_version(workspace_id,monitor_id,effective_at,version);
CREATE INDEX escalator_probe_replay_window ON escalator_probe_result(workspace_id,probe_id,scheduled_at,received_at,id);
CREATE INDEX escalator_signal_revision ON escalator_signal_event(workspace_id,source_id,source_version,id);
CREATE INDEX escalator_probe_revision ON escalator_probe_result(workspace_id,probe_id,probe_version,id);
