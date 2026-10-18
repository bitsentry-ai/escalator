-- Start recording now. Do not backdate current settings into legacy history.
CREATE TABLE escalator_rule_policy_fact (
 workspace_id text COLLATE "C" NOT NULL REFERENCES escalator_workspace(id),
 id bigserial NOT NULL,
 kind text COLLATE "C" NOT NULL CHECK(kind IN ('service','binding','policy','signal','probe','metric')),
 entity_id text COLLATE "C" NOT NULL,
 service_id text COLLATE "C" NOT NULL,
 environment_id text COLLATE "C",
 source_id text COLLATE "C",
 policy_id text COLLATE "C",
 enabled boolean NOT NULL,
 deleted boolean NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,id),
 CHECK((kind IN ('service','policy'))=(environment_id IS NULL)),
 CHECK((kind IN ('probe','metric'))=(source_id IS NOT NULL)),
 CHECK(kind='binding' OR policy_id IS NULL),
 CHECK(NOT(deleted AND enabled))
);
CREATE INDEX escalator_rule_policy_entity_history ON escalator_rule_policy_fact(workspace_id,kind,entity_id,recorded_at DESC,id DESC);
CREATE INDEX escalator_rule_policy_scope_history ON escalator_rule_policy_fact(workspace_id,service_id,environment_id,kind,recorded_at DESC,id DESC);
ALTER TABLE escalator_rule_policy_fact ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_rule_policy_fact FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_rule_policy_fact_scope ON escalator_rule_policy_fact
 USING(workspace_id=current_setting('app.workspace_id',true))
 WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
CREATE FUNCTION escalator_rule_policy_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Recorded rule policy is immutable' USING ERRCODE='23514';
END; $$;
CREATE TRIGGER escalator_rule_policy_immutable BEFORE UPDATE OR DELETE ON escalator_rule_policy_fact
 FOR EACH ROW EXECUTE FUNCTION escalator_rule_policy_immutable();
-- Project only enablement and identity. No configuration/credential JSON is retained.
CREATE FUNCTION escalator_append_rule_policy(fact_kind text, source_row jsonb, removed boolean)
 RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO escalator_rule_policy_fact(workspace_id,kind,entity_id,service_id,environment_id,source_id,policy_id,enabled,deleted)
 VALUES(source_row->>'workspace_id',fact_kind,source_row->>'id',
   CASE WHEN fact_kind='service' THEN source_row->>'id' ELSE source_row->>'service_id' END,
   CASE WHEN fact_kind IN ('service','policy') THEN NULL ELSE source_row->>'environment_id' END,
   CASE WHEN fact_kind IN ('probe','metric') THEN source_row->>'source_id' ELSE NULL END,
   CASE WHEN fact_kind='binding' THEN source_row->>'policy_id' ELSE NULL END,
   CASE WHEN removed THEN false WHEN fact_kind='service' THEN (source_row->>'enabled')::boolean
     ELSE (source_row->'data'->>'enabled')::boolean END,removed);
END; $$;
CREATE FUNCTION escalator_capture_rule_policy_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  PERFORM escalator_append_rule_policy(TG_ARGV[0],to_jsonb(OLD),true);
  RETURN OLD;
 END IF;
 PERFORM escalator_append_rule_policy(TG_ARGV[0],to_jsonb(NEW),false);
 RETURN NEW;
END; $$;
CREATE TRIGGER escalator_rule_service_policy AFTER INSERT OR UPDATE OR DELETE ON escalator_service
 FOR EACH ROW EXECUTE FUNCTION escalator_capture_rule_policy_change('service');
CREATE TRIGGER escalator_rule_binding_policy AFTER INSERT OR UPDATE OR DELETE ON escalator_detection_binding
 FOR EACH ROW EXECUTE FUNCTION escalator_capture_rule_policy_change('binding');
CREATE TRIGGER escalator_rule_paging_policy AFTER INSERT OR UPDATE OR DELETE ON escalator_policy
 FOR EACH ROW EXECUTE FUNCTION escalator_capture_rule_policy_change('policy');
CREATE TRIGGER escalator_rule_signal_policy AFTER INSERT OR UPDATE OR DELETE ON escalator_signal_source
 FOR EACH ROW EXECUTE FUNCTION escalator_capture_rule_policy_change('signal');
CREATE TRIGGER escalator_rule_probe_policy AFTER INSERT OR UPDATE OR DELETE ON escalator_probe
 FOR EACH ROW EXECUTE FUNCTION escalator_capture_rule_policy_change('probe');
CREATE TRIGGER escalator_rule_metric_policy AFTER INSERT OR UPDATE OR DELETE ON escalator_metric_monitor
 FOR EACH ROW EXECUTE FUNCTION escalator_capture_rule_policy_change('metric');
-- Explicit first observation for legacy resources, used while creating/reviewing
-- rules. Existing history is never rewritten, and the caller holds scope locks.
CREATE FUNCTION escalator_observe_rule_policy(fact_kind text, resource_id text)
 RETURNS void LANGUAGE plpgsql AS $$
DECLARE source_table text; source_row jsonb; scope text;
BEGIN
 scope:=current_setting('app.workspace_id',true);
 source_table:=CASE fact_kind WHEN 'service' THEN 'escalator_service'
   WHEN 'binding' THEN 'escalator_detection_binding' WHEN 'policy' THEN 'escalator_policy'
   WHEN 'signal' THEN 'escalator_signal_source' WHEN 'probe' THEN 'escalator_probe'
   WHEN 'metric' THEN 'escalator_metric_monitor' ELSE NULL END;
 IF source_table IS NULL THEN RAISE EXCEPTION 'Unknown rule policy resource' USING ERRCODE='22023'; END IF;
 EXECUTE format('SELECT to_jsonb(r) FROM %I r WHERE workspace_id=$1 AND id=$2 FOR SHARE',source_table)
   INTO source_row USING scope,resource_id;
 IF source_row IS NULL THEN RAISE EXCEPTION 'Rule policy resource unavailable' USING ERRCODE='23503'; END IF;
 IF NOT EXISTS(SELECT 1 FROM escalator_rule_policy_fact WHERE workspace_id=scope AND kind=fact_kind AND entity_id=resource_id) THEN
  PERFORM escalator_append_rule_policy(fact_kind,source_row,false);
 END IF;
END; $$;
