CREATE TABLE escalator_deployment_baseline (
 workspace_id text NOT NULL REFERENCES escalator_workspace(id),
 deployment_id text COLLATE "C" NOT NULL,
 target_id text NOT NULL,
 service_id text NOT NULL,
 environment_id text NOT NULL,
 started_at timestamptz NOT NULL,
 captured_at timestamptz NOT NULL,
 data jsonb NOT NULL,
 PRIMARY KEY(workspace_id,deployment_id),
 UNIQUE(workspace_id,deployment_id,service_id,environment_id),
 FOREIGN KEY(workspace_id,target_id,deployment_id) REFERENCES escalator_deployment(workspace_id,target_id,id),
 FOREIGN KEY(workspace_id,target_id,service_id,environment_id)
  REFERENCES escalator_deploy_target(workspace_id,id,service_id,environment_id),
 CHECK(captured_at>=started_at),
 CHECK(jsonb_typeof(data)='object' AND NOT(data ? 'workspaceId') AND octet_length(data::text)<=4000000),
 CHECK(data->>'formatVersion' IS NOT NULL AND data->>'formatVersion'='1' AND data->>'deploymentId' IS NOT NULL AND data->>'deploymentId'=deployment_id),
 CHECK(data->>'targetId' IS NOT NULL AND data->>'targetId'=target_id),
 CHECK(data->>'serviceId' IS NOT NULL AND data->>'serviceId'=service_id),
 CHECK(data->>'environmentId' IS NOT NULL AND data->>'environmentId'=environment_id),
 CHECK((data->>'startedAt')::timestamptz IS NOT NULL AND (data->>'startedAt')::timestamptz=started_at),
 CHECK((data->>'capturedAt')::timestamptz IS NOT NULL AND (data->>'capturedAt')::timestamptz=captured_at),
 CHECK(data ? 'inventoryComplete' AND jsonb_typeof(data->'inventoryComplete')='boolean'),
 CHECK(data ? 'streams' AND jsonb_typeof(data->'streams')='array' AND jsonb_array_length(data->'streams')<=128),
 CHECK(NOT jsonb_path_exists(data,'$.streams[*].evidence.workspaceId'))
);
CREATE UNIQUE INDEX escalator_source_binding ON escalator_signal_source(workspace_id,id,service_id,environment_id);
CREATE TABLE escalator_deployment_pin (
 workspace_id text NOT NULL,
 deployment_id text NOT NULL,
 source_id text NOT NULL,
 service_id text NOT NULL,
 environment_id text NOT NULL,
 purpose text NOT NULL CHECK(purpose IN ('baseline','watch')),
 starts_at timestamptz NOT NULL,
 ends_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 PRIMARY KEY(workspace_id,deployment_id,source_id,purpose),
 FOREIGN KEY(workspace_id,deployment_id,service_id,environment_id)
  REFERENCES escalator_deployment_baseline(workspace_id,deployment_id,service_id,environment_id),
 FOREIGN KEY(workspace_id,source_id,service_id,environment_id)
  REFERENCES escalator_signal_source(workspace_id,id,service_id,environment_id),
 CHECK(ends_at>starts_at AND ends_at<=starts_at+interval '30 minutes'),
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '604800 seconds')
);
CREATE INDEX escalator_deployment_pin_source ON escalator_deployment_pin(workspace_id,source_id,expires_at,starts_at,ends_at);
ALTER TABLE escalator_deployment_baseline ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_deployment_baseline FORCE ROW LEVEL SECURITY;
CREATE POLICY baseline_read ON escalator_deployment_baseline FOR SELECT
 USING(workspace_id=current_setting('app.workspace_id',true));
CREATE POLICY baseline_insert ON escalator_deployment_baseline FOR INSERT
 WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
ALTER TABLE escalator_deployment_pin ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_deployment_pin FORCE ROW LEVEL SECURITY;
CREATE POLICY deployment_pin_read ON escalator_deployment_pin FOR SELECT
 USING(workspace_id=current_setting('app.workspace_id',true));
CREATE POLICY deployment_pin_insert ON escalator_deployment_pin FOR INSERT
 WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
-- No mutation of saved baselines or pin expiries. Only expired pins can be removed.
CREATE POLICY deployment_pin_expired ON escalator_deployment_pin FOR DELETE
 USING(workspace_id=current_setting('app.workspace_id',true) AND expires_at<=clock_timestamp());
