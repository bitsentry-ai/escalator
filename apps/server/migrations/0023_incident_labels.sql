CREATE TABLE escalator_incident_label (
 workspace_id text COLLATE "C" NOT NULL REFERENCES escalator_workspace(id),
 id text COLLATE "C" NOT NULL,
 service_id text COLLATE "C" NOT NULL,
 environment_id text COLLATE "C" NOT NULL,
 stream_kind text COLLATE "C" NOT NULL CHECK(stream_kind IN ('metric','probe','signal')),
 stream_id text COLLATE "C" NOT NULL,
 incident_id text COLLATE "C",
 revision bigint NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
 status text COLLATE "C" NOT NULL CHECK(status IN ('draft','reviewed')),
 created_by text COLLATE "C" NOT NULL,
 reviewed_by text COLLATE "C",
 data jsonb NOT NULL,
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,service_id) REFERENCES escalator_service(workspace_id,id),
 FOREIGN KEY(workspace_id,environment_id) REFERENCES escalator_environment(workspace_id,id),
 FOREIGN KEY(workspace_id,incident_id,service_id,environment_id) REFERENCES escalator_incident(workspace_id,id,service_id,environment_id),
 FOREIGN KEY(workspace_id,created_by) REFERENCES escalator_responder(workspace_id,id),
 FOREIGN KEY(workspace_id,reviewed_by) REFERENCES escalator_responder(workspace_id,id),
 CHECK((status='reviewed')=(reviewed_by IS NOT NULL)),
 CHECK(jsonb_typeof(data)='object' AND octet_length(data::text)<=32768 AND NOT(data ? 'workspaceId')),
 CHECK(data->>'id' IS NOT NULL AND data->>'id'=id),
 CHECK(data->>'serviceId' IS NOT NULL AND data->>'serviceId'=service_id),
 CHECK(data->>'environmentId' IS NOT NULL AND data->>'environmentId'=environment_id),
 CHECK(data->'stream'->>'kind' IS NOT NULL AND data->'stream'->>'kind'=stream_kind),
 CHECK(data->'stream'->>'id' IS NOT NULL AND data->'stream'->>'id'=stream_id),
 CHECK(data ? 'incidentId' AND (data->>'incidentId') IS NOT DISTINCT FROM incident_id),
 CHECK((data->>'revision')::bigint IS NOT NULL AND (data->>'revision')::bigint=revision),
 CHECK(data->>'status' IS NOT NULL AND data->>'status'=status),
 CHECK(data->>'createdBy' IS NOT NULL AND data->>'createdBy'=created_by),
 CHECK(data ? 'reviewedBy' AND (data->>'reviewedBy') IS NOT DISTINCT FROM reviewed_by),
 CHECK(data->>'origin' IS NOT NULL AND data->>'origin' IN ('incident_review','missed_incident')),
 CHECK((data->>'origin'='incident_review')=(incident_id IS NOT NULL)),
 CHECK(data->>'outcome' IS NOT NULL AND data->>'outcome' IN ('actionable','noise')),
 CHECK(data->>'origin'<>'missed_incident' OR data->>'outcome'='actionable')
);
CREATE INDEX escalator_incident_label_scope_page ON escalator_incident_label(workspace_id,service_id,environment_id,id);
CREATE INDEX escalator_incident_label_stream_page ON escalator_incident_label(workspace_id,service_id,environment_id,stream_kind,stream_id,status,id);
ALTER TABLE escalator_incident_label ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_incident_label FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_incident_label_scope ON escalator_incident_label
 USING(workspace_id=current_setting('app.workspace_id',true))
 WITH CHECK(workspace_id=current_setting('app.workspace_id',true));

-- Reviewed human evidence is immutable, including through direct adapter SQL.
CREATE FUNCTION escalator_guard_incident_label() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status='reviewed' THEN
  RAISE EXCEPTION 'Reviewed incident label is immutable' USING ERRCODE='23514';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.id IS DISTINCT FROM OLD.id
  OR NEW.service_id IS DISTINCT FROM OLD.service_id OR NEW.environment_id IS DISTINCT FROM OLD.environment_id
  OR NEW.stream_kind IS DISTINCT FROM OLD.stream_kind OR NEW.stream_id IS DISTINCT FROM OLD.stream_id
  OR NEW.incident_id IS DISTINCT FROM OLD.incident_id OR NEW.created_by IS DISTINCT FROM OLD.created_by
  OR (NEW.data->>'createdAt') IS DISTINCT FROM (OLD.data->>'createdAt')
  OR (NEW.data->>'origin') IS DISTINCT FROM (OLD.data->>'origin')
  OR NEW.revision<>OLD.revision+1 THEN
  RAISE EXCEPTION 'Incident label identity or revision changed unexpectedly' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER escalator_incident_label_immutable BEFORE UPDATE OR DELETE ON escalator_incident_label
 FOR EACH ROW EXECUTE FUNCTION escalator_guard_incident_label();
