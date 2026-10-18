CREATE UNIQUE INDEX escalator_probe_binding ON escalator_probe(workspace_id,id,source_id,service_id,environment_id);
CREATE TABLE escalator_watch_cadence_lease (
 workspace_id text NOT NULL REFERENCES escalator_workspace(id),
 probe_id text COLLATE "C" NOT NULL,
 target_id text NOT NULL,
 source_id text NOT NULL,
 service_id text NOT NULL,
 environment_id text NOT NULL,
 generation_id text NOT NULL,
 generation_deployment_id text COLLATE "C" NOT NULL,
 revision bigint NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
 original_interval_seconds integer NOT NULL CHECK(original_interval_seconds BETWEEN 61 AND 3600),
 applied_probe_version bigint NOT NULL CHECK(applied_probe_version BETWEEN 2 AND 9007199254740991),
 created_at timestamptz NOT NULL,
 restore_at timestamptz NOT NULL CHECK(restore_at>created_at),
 data jsonb NOT NULL,
 PRIMARY KEY(workspace_id,probe_id),
 FOREIGN KEY(workspace_id,probe_id,source_id,service_id,environment_id) REFERENCES escalator_probe(workspace_id,id,source_id,service_id,environment_id),
 FOREIGN KEY(workspace_id,target_id,service_id,environment_id) REFERENCES escalator_deploy_target(workspace_id,id,service_id,environment_id),
 FOREIGN KEY(workspace_id,target_id,generation_deployment_id) REFERENCES escalator_deployment(workspace_id,target_id,id),
 FOREIGN KEY(workspace_id,generation_deployment_id) REFERENCES escalator_deployment_watch(workspace_id,deployment_id),
 CHECK(jsonb_typeof(data)='object' AND NOT(data ? 'workspaceId') AND octet_length(data::text)<=64000),
 CHECK(data->>'probeId' IS NOT NULL AND data->>'probeId'=(probe_id)),
 CHECK(data->>'targetId' IS NOT NULL AND data->>'targetId'=(target_id)),
 CHECK(data->>'sourceId' IS NOT NULL AND data->>'sourceId'=(source_id)),
 CHECK(data->>'serviceId' IS NOT NULL AND data->>'serviceId'=(service_id)),
 CHECK(data->>'environmentId' IS NOT NULL AND data->>'environmentId'=(environment_id)),
 CHECK(data->>'generationId' IS NOT NULL AND data->>'generationId'=(generation_id)),
 CHECK(data->>'generationDeploymentId' IS NOT NULL AND data->>'generationDeploymentId'=(generation_deployment_id)),
 CHECK(data->>'revision' IS NOT NULL AND (data->>'revision')::bigint=(revision)),
 CHECK(data->>'originalIntervalSeconds' IS NOT NULL AND (data->>'originalIntervalSeconds')::integer=(original_interval_seconds)),
 CHECK(data->>'appliedProbeVersion' IS NOT NULL AND (data->>'appliedProbeVersion')::bigint=(applied_probe_version)),
 CHECK(data->>'createdAt' IS NOT NULL AND (data->>'createdAt')::timestamptz=(created_at)),
 CHECK(data->>'restoreAt' IS NOT NULL AND (data->>'restoreAt')::timestamptz=(restore_at))
);
CREATE TABLE escalator_watch_cadence_receipt (
 workspace_id text NOT NULL REFERENCES escalator_workspace(id),
 probe_id text COLLATE "C" NOT NULL,
 target_id text NOT NULL,
 source_id text NOT NULL,
 service_id text NOT NULL,
 environment_id text NOT NULL,
 deployment_id text COLLATE "C" NOT NULL,
 recorded_at timestamptz NOT NULL,
 decision text NOT NULL CHECK(decision IN ('tightened','joined','already_fast','disabled','capacity_limited','superseded','expired')),
 generation_id text,
 applied_probe_version bigint CHECK(applied_probe_version BETWEEN 2 AND 9007199254740991),
 data jsonb NOT NULL,
 PRIMARY KEY(workspace_id,deployment_id,probe_id),
 FOREIGN KEY(workspace_id,probe_id,source_id,service_id,environment_id) REFERENCES escalator_probe(workspace_id,id,source_id,service_id,environment_id),
 FOREIGN KEY(workspace_id,target_id,service_id,environment_id) REFERENCES escalator_deploy_target(workspace_id,id,service_id,environment_id),
 FOREIGN KEY(workspace_id,target_id,deployment_id) REFERENCES escalator_deployment(workspace_id,target_id,id),
 FOREIGN KEY(workspace_id,deployment_id) REFERENCES escalator_deployment_watch(workspace_id,deployment_id),
 CHECK((decision IN ('tightened','joined') AND generation_id IS NOT NULL AND applied_probe_version IS NOT NULL)
   OR (decision NOT IN ('tightened','joined') AND generation_id IS NULL AND applied_probe_version IS NULL)),
 CHECK(data ? 'generationId' AND data->>'generationId' IS NOT DISTINCT FROM generation_id),
 CHECK(data ? 'appliedProbeVersion' AND (data->>'appliedProbeVersion')::bigint IS NOT DISTINCT FROM applied_probe_version),
 CHECK(jsonb_typeof(data)='object' AND NOT(data ? 'workspaceId') AND octet_length(data::text)<=64000),
 CHECK(data->>'probeId' IS NOT NULL AND data->>'probeId'=(probe_id)),
 CHECK(data->>'targetId' IS NOT NULL AND data->>'targetId'=(target_id)),
 CHECK(data->>'sourceId' IS NOT NULL AND data->>'sourceId'=(source_id)),
 CHECK(data->>'serviceId' IS NOT NULL AND data->>'serviceId'=(service_id)),
 CHECK(data->>'environmentId' IS NOT NULL AND data->>'environmentId'=(environment_id)),
 CHECK(data->>'deploymentId' IS NOT NULL AND data->>'deploymentId'=(deployment_id)),
 CHECK(data->>'recordedAt' IS NOT NULL AND (data->>'recordedAt')::timestamptz=(recorded_at)),
 CHECK(data->>'decision' IS NOT NULL AND data->>'decision'=(decision))
);
ALTER TABLE escalator_watch_cadence_lease ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_watch_cadence_lease FORCE ROW LEVEL SECURITY;
CREATE POLICY cadence_lease_read ON escalator_watch_cadence_lease FOR SELECT USING(workspace_id=current_setting('app.workspace_id',true));
CREATE POLICY cadence_lease_insert ON escalator_watch_cadence_lease FOR INSERT WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
CREATE POLICY cadence_lease_update ON escalator_watch_cadence_lease FOR UPDATE USING(workspace_id=current_setting('app.workspace_id',true)) WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
CREATE POLICY cadence_lease_delete ON escalator_watch_cadence_lease FOR DELETE USING(workspace_id=current_setting('app.workspace_id',true));
ALTER TABLE escalator_watch_cadence_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_watch_cadence_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY cadence_receipt_read ON escalator_watch_cadence_receipt FOR SELECT USING(workspace_id=current_setting('app.workspace_id',true));
CREATE POLICY cadence_receipt_insert ON escalator_watch_cadence_receipt FOR INSERT WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
