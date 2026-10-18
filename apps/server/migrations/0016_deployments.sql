CREATE TABLE escalator_deploy_target (
 workspace_id text NOT NULL REFERENCES escalator_workspace(id),
 id text COLLATE "C" NOT NULL,
 service_id text NOT NULL,
 environment_id text NOT NULL,
 policy_id text NOT NULL,
 revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
 data jsonb NOT NULL,
 PRIMARY KEY (workspace_id,id),
 UNIQUE (workspace_id,service_id,environment_id),
 UNIQUE (workspace_id,id,service_id,environment_id),
 FOREIGN KEY (workspace_id,service_id) REFERENCES escalator_service(workspace_id,id),
 FOREIGN KEY (workspace_id,environment_id) REFERENCES escalator_environment(workspace_id,id),
 FOREIGN KEY (workspace_id,policy_id) REFERENCES escalator_policy(workspace_id,id),
 CHECK (jsonb_typeof(data)='object' AND NOT(data ? 'workspaceId')),
 CHECK (data->>'id' IS NOT NULL AND data->>'id'=id),
 CHECK (data->>'serviceId' IS NOT NULL AND data->>'serviceId'=service_id),
 CHECK (data->>'environmentId' IS NOT NULL AND data->>'environmentId'=environment_id),
 CHECK (data->>'policyId' IS NOT NULL AND data->>'policyId'=policy_id),
 CHECK ((data->>'revision')::bigint IS NOT NULL AND (data->>'revision')::bigint=revision)
);
CREATE TABLE escalator_deploy_grant (
 workspace_id text NOT NULL REFERENCES escalator_workspace(id),
 id text COLLATE "C" NOT NULL,
 target_id text NOT NULL,
 token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
 mapped_deployer_id text,
 data jsonb NOT NULL,
 PRIMARY KEY (workspace_id,id),
 UNIQUE (workspace_id,target_id,id),
 FOREIGN KEY (workspace_id,target_id) REFERENCES escalator_deploy_target(workspace_id,id),
 FOREIGN KEY (workspace_id,mapped_deployer_id) REFERENCES escalator_responder(workspace_id,id),
 CHECK (jsonb_typeof(data)='object' AND NOT(data ? 'workspaceId')),
 CHECK (data->>'id' IS NOT NULL AND data->>'id'=id),
 CHECK (data->>'targetId' IS NOT NULL AND data->>'targetId'=target_id),
 CHECK (data->>'tokenHash' IS NOT NULL AND data->>'tokenHash'=token_hash),
 CHECK (mapped_deployer_id IS NOT DISTINCT FROM data->>'mappedDeployerId')
);
CREATE INDEX escalator_deploy_grant_target ON escalator_deploy_grant(workspace_id,target_id,id);

CREATE TABLE escalator_deployment (
 workspace_id text NOT NULL REFERENCES escalator_workspace(id),
 id text COLLATE "C" NOT NULL,
 target_id text NOT NULL,
 service_id text NOT NULL,
 environment_id text NOT NULL,
 token_id text NOT NULL,
 mapped_deployer_id text,
 policy_id text NOT NULL,
 source text COLLATE "C" NOT NULL,
 external_id text COLLATE "C" NOT NULL,
 revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
 status text NOT NULL CHECK (status IN ('STARTED','SUCCEEDED','FAILED','CANCELLED','TIMED_OUT')),
 started_at timestamptz NOT NULL,
 timeout_at timestamptz NOT NULL,
 data jsonb NOT NULL,
 policy jsonb NOT NULL,
 PRIMARY KEY (workspace_id,id),
 UNIQUE (workspace_id,target_id,id),
 UNIQUE (workspace_id,target_id,source,external_id),
 FOREIGN KEY (workspace_id,target_id,service_id,environment_id)
  REFERENCES escalator_deploy_target(workspace_id,id,service_id,environment_id),
 FOREIGN KEY (workspace_id,target_id,token_id) REFERENCES escalator_deploy_grant(workspace_id,target_id,id),
 FOREIGN KEY (workspace_id,mapped_deployer_id) REFERENCES escalator_responder(workspace_id,id),
 FOREIGN KEY (workspace_id,policy_id) REFERENCES escalator_policy(workspace_id,id),
 CHECK (jsonb_typeof(data)='object' AND NOT(data ? 'workspaceId')),
 CHECK (jsonb_typeof(policy)='object' AND NOT(policy ? 'workspaceId')),
 CHECK (data->>'id' IS NOT NULL AND data->>'id'=id),
 CHECK (data->>'serviceId' IS NOT NULL AND data->>'serviceId'=service_id),
 CHECK (data->>'environmentId' IS NOT NULL AND data->>'environmentId'=environment_id),
 CHECK (data->>'tokenId' IS NOT NULL AND data->>'tokenId'=token_id),
 CHECK (mapped_deployer_id IS NOT DISTINCT FROM data->>'mappedDeployerId'),
 CHECK (data->>'source' IS NOT NULL AND data->>'source'=source),
 CHECK (data->>'externalId' IS NOT NULL AND data->>'externalId'=external_id),
 CHECK ((data->>'revision')::bigint IS NOT NULL AND (data->>'revision')::bigint=revision),
 CHECK (data->>'status' IS NOT NULL AND data->>'status'=status),
 CHECK ((data->>'startedAt')::timestamptz IS NOT NULL AND (data->>'startedAt')::timestamptz=started_at),
 CHECK ((data->>'timeoutAt')::timestamptz IS NOT NULL AND (data->>'timeoutAt')::timestamptz=timeout_at),
 CHECK (policy->>'id' IS NOT NULL AND policy->>'id'=policy_id),
 CHECK (policy->>'serviceId' IS NOT NULL AND policy->>'serviceId'=service_id)
);
CREATE INDEX escalator_deployment_due ON escalator_deployment(workspace_id,status,timeout_at,id);
CREATE INDEX escalator_deployment_history ON escalator_deployment(workspace_id,service_id,environment_id,started_at,id);

CREATE TABLE escalator_deploy_receipt (
 workspace_id text NOT NULL REFERENCES escalator_workspace(id),
 target_id text NOT NULL,
 idempotency_key text COLLATE "C" NOT NULL,
 token_id text NOT NULL,
 deployment_id text,
 request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
 data jsonb NOT NULL,
 PRIMARY KEY (workspace_id,target_id,idempotency_key),
 FOREIGN KEY (workspace_id,target_id) REFERENCES escalator_deploy_target(workspace_id,id),
 FOREIGN KEY (workspace_id,target_id,token_id) REFERENCES escalator_deploy_grant(workspace_id,target_id,id),
 FOREIGN KEY (workspace_id,target_id,deployment_id) REFERENCES escalator_deployment(workspace_id,target_id,id),
 CHECK (jsonb_typeof(data)='object' AND NOT(data ? 'workspaceId')),
 CHECK (data->>'targetId' IS NOT NULL AND data->>'targetId'=target_id),
 CHECK (data->>'key' IS NOT NULL AND data->>'key'=idempotency_key),
 CHECK (data->>'tokenId' IS NOT NULL AND data->>'tokenId'=token_id),
 CHECK (data->>'requestHash' IS NOT NULL AND data->>'requestHash'=request_hash),
 CHECK (data->>'action' IS NOT NULL AND data->>'action' IN ('start','finish')),
 CHECK (jsonb_typeof(data->'result')='object' AND data->'result'->>'state' IS NOT NULL),
 CHECK ((data->'result'->>'state'='rejected' AND deployment_id IS NULL)
   OR (data->'result'->>'state' IN ('accepted','duplicate') AND deployment_id IS NOT NULL
       AND data->'result'->>'deploymentId' IS NOT NULL AND data->'result'->>'deploymentId'=deployment_id))
);

-- All names are a closed migration-owned set; no application input is interpolated.
DO $migration$
DECLARE table_name text;
BEGIN
 FOREACH table_name IN ARRAY ARRAY['escalator_deploy_target','escalator_deploy_grant','escalator_deployment','escalator_deploy_receipt'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
  EXECUTE format($policy$CREATE POLICY deploy_scope ON %I
   USING (workspace_id=current_setting('app.workspace_id',true))
   WITH CHECK (workspace_id=current_setting('app.workspace_id',true))$policy$,table_name);
 END LOOP;
END;
$migration$;
-- Authentication can project one exact hash. It cannot write with this SELECT-only policy.
CREATE POLICY escalator_deploy_grant_lookup ON escalator_deploy_grant FOR SELECT
 USING (token_hash=nullif(current_setting('app.deployment_token_hash',true),''));
