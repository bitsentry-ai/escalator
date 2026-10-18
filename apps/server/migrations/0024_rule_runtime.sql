-- No rules are activated or historical policy invented by this migration.
CREATE TABLE escalator_rule_version (
 workspace_id text COLLATE "C" NOT NULL REFERENCES escalator_workspace(id),
 rule_id text COLLATE "C" NOT NULL,
 revision bigint NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
 service_id text COLLATE "C" NOT NULL,
 environment_id text COLLATE "C" NOT NULL,
 definition jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,rule_id,revision),
 UNIQUE(workspace_id,rule_id,revision,service_id,environment_id),
 FOREIGN KEY(workspace_id,service_id) REFERENCES escalator_service(workspace_id,id),
 FOREIGN KEY(workspace_id,environment_id) REFERENCES escalator_environment(workspace_id,id),
 CHECK(jsonb_typeof(definition)='object' AND octet_length(definition::text)<=32768 AND NOT(definition ? 'workspaceId')),
 CHECK(definition->>'serviceId' IS NOT NULL AND definition->>'serviceId'=service_id),
 CHECK(definition->>'environmentId' IS NOT NULL AND definition->>'environmentId'=environment_id)
);
CREATE TABLE escalator_rule_runtime (
 workspace_id text COLLATE "C" NOT NULL,
 rule_id text COLLATE "C" NOT NULL,
 rule_revision bigint NOT NULL,
 generation bigint NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740991),
 revision bigint NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
 service_id text COLLATE "C" NOT NULL,
 environment_id text COLLATE "C" NOT NULL,
 incident_id text COLLATE "C",
 due_at timestamptz NOT NULL,
 retired_at timestamptz,
 data jsonb NOT NULL,
 PRIMARY KEY(workspace_id,rule_id),
 FOREIGN KEY(workspace_id,rule_id,rule_revision,service_id,environment_id) REFERENCES escalator_rule_version(workspace_id,rule_id,revision,service_id,environment_id),
 FOREIGN KEY(workspace_id,incident_id,service_id,environment_id) REFERENCES escalator_incident(workspace_id,id,service_id,environment_id),
 CHECK(jsonb_typeof(data)='object' AND octet_length(data::text)<=32768 AND NOT(data ?| ARRAY['workspaceId','version'])),
 CHECK((data->>'generation')::bigint IS NOT NULL AND (data->>'generation')::bigint=generation),
 CHECK((data->>'revision')::bigint IS NOT NULL AND (data->>'revision')::bigint=revision),
 CHECK(data ? 'incidentId' AND (data->>'incidentId') IS NOT DISTINCT FROM incident_id),
 CHECK((data->>'dueAt')::timestamptz IS NOT NULL AND (data->>'dueAt')::timestamptz=due_at),
 CHECK(data->>'mode' IS NOT NULL AND data->>'mode' IN ('active','shadow')),
 CHECK(data ? 'state' AND (data->'state'='null'::jsonb OR (jsonb_typeof(data->'state')='object' AND NOT(data->'state' ? 'workspaceId'))))
);
CREATE INDEX escalator_rule_runtime_due ON escalator_rule_runtime(workspace_id,due_at,rule_id) WHERE retired_at IS NULL;
CREATE TABLE escalator_rule_decision (
 workspace_id text COLLATE "C" NOT NULL,
 rule_id text COLLATE "C" NOT NULL,
 rule_revision bigint NOT NULL,
 generation bigint NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740991),
 decision_at timestamptz NOT NULL,
 data jsonb NOT NULL,
 PRIMARY KEY(workspace_id,rule_id,generation,decision_at),
 FOREIGN KEY(workspace_id,rule_id,rule_revision) REFERENCES escalator_rule_version(workspace_id,rule_id,revision),
 CHECK(jsonb_typeof(data)='object' AND octet_length(data::text)<=65536 AND NOT(data ? 'workspaceId')),
 CHECK(jsonb_typeof(data->'state')='object' AND NOT(data->'state' ? 'workspaceId')),
 CHECK(data->'state'->>'ruleId' IS NOT NULL AND data->'state'->>'ruleId'=rule_id),
 CHECK((data->'state'->>'revision')::bigint IS NOT NULL AND (data->'state'->>'revision')::bigint=rule_revision),
 CHECK((data->'state'->>'lastDecisionAt')::timestamptz IS NOT NULL AND (data->'state'->>'lastDecisionAt')::timestamptz=decision_at)
);
ALTER TABLE escalator_rule_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_rule_version FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_rule_version_scope ON escalator_rule_version
 USING(workspace_id=current_setting('app.workspace_id',true))
 WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
ALTER TABLE escalator_rule_runtime ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_rule_runtime FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_rule_runtime_scope ON escalator_rule_runtime
 USING(workspace_id=current_setting('app.workspace_id',true))
 WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
ALTER TABLE escalator_rule_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_rule_decision FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_rule_decision_scope ON escalator_rule_decision
 USING(workspace_id=current_setting('app.workspace_id',true))
 WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
CREATE FUNCTION escalator_rule_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Rule revision and decision history are immutable' USING ERRCODE='23514';
END; $$;
CREATE TRIGGER escalator_rule_version_immutable BEFORE UPDATE OR DELETE ON escalator_rule_version
 FOR EACH ROW EXECUTE FUNCTION escalator_rule_immutable();
CREATE TRIGGER escalator_rule_decision_immutable BEFORE UPDATE OR DELETE ON escalator_rule_decision
 FOR EACH ROW EXECUTE FUNCTION escalator_rule_immutable();
CREATE FUNCTION escalator_guard_rule_runtime() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Rule runtime must be retired' USING ERRCODE='23514'; END IF;
 IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.rule_id IS DISTINCT FROM OLD.rule_id THEN
  RAISE EXCEPTION 'Rule runtime scope is immutable' USING ERRCODE='23514';
 END IF;
 IF NEW.generation=OLD.generation THEN
  IF OLD.retired_at IS NOT NULL OR NEW.revision<>OLD.revision+1
   OR NEW.rule_revision<>OLD.rule_revision OR NEW.service_id<>OLD.service_id OR NEW.environment_id<>OLD.environment_id
   OR NEW.data->>'mode' IS DISTINCT FROM OLD.data->>'mode'
   OR NEW.data->>'title' IS DISTINCT FROM OLD.data->>'title'
   OR NEW.data->>'measurementHash' IS DISTINCT FROM OLD.data->>'measurementHash' THEN
   RAISE EXCEPTION 'Rule evaluation cannot change activation binding' USING ERRCODE='23514';
  END IF;
 ELSIF NEW.generation=OLD.generation+1 THEN
  IF OLD.retired_at IS NULL OR NEW.retired_at IS NOT NULL
   OR NEW.revision<>1 OR NEW.incident_id IS NOT NULL OR NEW.data->'state' IS DISTINCT FROM 'null'::jsonb THEN
   RAISE EXCEPTION 'Rule reactivation requires a retired runtime and fresh state' USING ERRCODE='23514';
  END IF;
 ELSE
  RAISE EXCEPTION 'Invalid rule activation generation' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER escalator_rule_runtime_guard BEFORE UPDATE OR DELETE ON escalator_rule_runtime
 FOR EACH ROW EXECUTE FUNCTION escalator_guard_rule_runtime();
