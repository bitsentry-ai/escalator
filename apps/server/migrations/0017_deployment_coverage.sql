CREATE TABLE escalator_coverage_decision (
 workspace_id text NOT NULL REFERENCES escalator_workspace(id),
 id text COLLATE "C" NOT NULL,
 target_id text NOT NULL,
 service_id text NOT NULL,
 environment_id text NOT NULL,
 policy_id text NOT NULL,
 mapped_deployer_id text,
 override_actor_id text,
 idempotency_key text COLLATE "C" NOT NULL,
 request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
 evaluated_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 data jsonb NOT NULL,
 PRIMARY KEY (workspace_id,id),
 UNIQUE (workspace_id,target_id,idempotency_key),
 FOREIGN KEY (workspace_id,target_id,service_id,environment_id)
  REFERENCES escalator_deploy_target(workspace_id,id,service_id,environment_id),
 FOREIGN KEY (workspace_id,policy_id) REFERENCES escalator_policy(workspace_id,id),
 FOREIGN KEY (workspace_id,mapped_deployer_id) REFERENCES escalator_responder(workspace_id,id),
 FOREIGN KEY (workspace_id,override_actor_id) REFERENCES escalator_responder(workspace_id,id),
 CHECK (expires_at>evaluated_at AND expires_at<=evaluated_at+interval '5 minutes'),
 CHECK (jsonb_typeof(data)='object' AND NOT(data ? 'workspaceId')),
 CHECK (data->>'id' IS NOT NULL AND data->>'id'=id),
 CHECK (data ? 'binding' AND jsonb_typeof(data->'binding')='object' AND NOT(data->'binding' ? 'workspaceId')),
 CHECK (data->'binding'->>'targetId' IS NOT NULL AND data->'binding'->>'targetId'=target_id),
 CHECK (data->'binding'->>'serviceId' IS NOT NULL AND data->'binding'->>'serviceId'=service_id),
 CHECK (data->'binding'->>'environmentId' IS NOT NULL AND data->'binding'->>'environmentId'=environment_id),
 CHECK (data->'binding'->>'policyId' IS NOT NULL AND data->'binding'->>'policyId'=policy_id),
 CHECK (data->'binding' ? 'mappedDeployerId' AND mapped_deployer_id IS NOT DISTINCT FROM data->'binding'->>'mappedDeployerId'),
 CHECK (data ? 'override' AND (
  (data->'override'='null'::jsonb AND override_actor_id IS NULL) OR
  (jsonb_typeof(data->'override')='object' AND override_actor_id IS NOT NULL
   AND data->'override'->>'responderId' IS NOT NULL AND data->'override'->>'responderId'=override_actor_id))),
 CHECK ((data->>'evaluatedAt')::timestamptz IS NOT NULL AND (data->>'evaluatedAt')::timestamptz=evaluated_at),
 CHECK ((data->>'expiresAt')::timestamptz IS NOT NULL AND (data->>'expiresAt')::timestamptz=expires_at)
);
ALTER TABLE escalator_coverage_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_coverage_decision FORCE ROW LEVEL SECURITY;
-- No UPDATE or DELETE policy: saved proofs and command keys are append-only.
CREATE POLICY coverage_read ON escalator_coverage_decision FOR SELECT
 USING (workspace_id=current_setting('app.workspace_id',true));
CREATE POLICY coverage_insert ON escalator_coverage_decision FOR INSERT
 WITH CHECK (workspace_id=current_setting('app.workspace_id',true));
