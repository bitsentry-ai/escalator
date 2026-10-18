CREATE UNIQUE INDEX escalator_incident_binding ON escalator_incident(workspace_id,id,service_id,environment_id);
CREATE TABLE escalator_deployment_watch (
 workspace_id text NOT NULL REFERENCES escalator_workspace(id),
 deployment_id text COLLATE "C" NOT NULL,
 target_id text NOT NULL,
 service_id text NOT NULL,
 environment_id text NOT NULL,
 revision bigint NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
 started_at timestamptz NOT NULL,
 ends_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL,
 finalized_at timestamptz,
 verdict text NOT NULL CHECK(verdict IN ('PENDING','PASS','WARN','FAIL','INSUFFICIENT_DATA')),
 incident_id text,
 data jsonb NOT NULL,
 PRIMARY KEY(workspace_id,deployment_id),
 FOREIGN KEY(workspace_id,target_id,deployment_id) REFERENCES escalator_deployment(workspace_id,target_id,id),
 FOREIGN KEY(workspace_id,target_id,service_id,environment_id) REFERENCES escalator_deploy_target(workspace_id,id,service_id,environment_id),
 FOREIGN KEY(workspace_id,incident_id,service_id,environment_id) REFERENCES escalator_incident(workspace_id,id,service_id,environment_id),
 CHECK(ends_at=started_at+interval '1800 seconds' AND updated_at>=started_at),
 CHECK(finalized_at IS NULL OR (finalized_at>=ends_at+interval '120 seconds' AND finalized_at=updated_at AND verdict<>'PENDING')),
 CHECK((verdict='FAIL')=(incident_id IS NOT NULL)),
 CHECK(verdict NOT IN ('PASS','WARN') OR finalized_at IS NOT NULL),
 CHECK(jsonb_typeof(data)='object' AND NOT(data ? 'workspaceId') AND octet_length(data::text)<=4000000),
 CHECK(data->>'formatVersion' IS NOT NULL AND data->>'formatVersion'='1'),
 CHECK(data->>'deploymentId' IS NOT NULL AND data->>'deploymentId'=deployment_id),
 CHECK(data->>'targetId' IS NOT NULL AND data->>'targetId'=target_id),
 CHECK(data->>'serviceId' IS NOT NULL AND data->>'serviceId'=service_id),
 CHECK(data->>'environmentId' IS NOT NULL AND data->>'environmentId'=environment_id),
 CHECK((data->>'revision')::bigint IS NOT NULL AND (data->>'revision')::bigint=revision),
 CHECK((data->>'startedAt')::timestamptz IS NOT NULL AND (data->>'startedAt')::timestamptz=started_at),
 CHECK((data->>'endsAt')::timestamptz IS NOT NULL AND (data->>'endsAt')::timestamptz=ends_at),
 CHECK((data->>'updatedAt')::timestamptz IS NOT NULL AND (data->>'updatedAt')::timestamptz=updated_at),
 CHECK(data ? 'finalizedAt' AND (data->>'finalizedAt')::timestamptz IS NOT DISTINCT FROM finalized_at),
 CHECK(data->>'verdict' IS NOT NULL AND data->>'verdict'=verdict),
 CHECK(data ? 'incidentId' AND data->>'incidentId' IS NOT DISTINCT FROM incident_id)
);
CREATE INDEX escalator_deployment_watch_pending ON escalator_deployment_watch(workspace_id,ends_at,deployment_id) WHERE finalized_at IS NULL;
ALTER TABLE escalator_deployment_watch ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_deployment_watch FORCE ROW LEVEL SECURITY;
CREATE POLICY deployment_watch_read ON escalator_deployment_watch FOR SELECT USING(workspace_id=current_setting('app.workspace_id',true));
CREATE POLICY deployment_watch_insert ON escalator_deployment_watch FOR INSERT WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
CREATE POLICY deployment_watch_update ON escalator_deployment_watch FOR UPDATE USING(workspace_id=current_setting('app.workspace_id',true)) WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
