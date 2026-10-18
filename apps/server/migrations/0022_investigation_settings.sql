-- One selected model per service/environment. Source links are normalized and scoped.
CREATE TABLE escalator_investigation_settings (
 workspace_id text COLLATE "C" NOT NULL REFERENCES escalator_workspace(id),
 id text COLLATE "C" NOT NULL,
 service_id text COLLATE "C" NOT NULL,
 environment_id text COLLATE "C" NOT NULL,
 model_secret_id text COLLATE "C",
 revision bigint NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
 enabled boolean NOT NULL,
 data jsonb NOT NULL,
 PRIMARY KEY(workspace_id,id),
 UNIQUE(workspace_id,service_id,environment_id),
 FOREIGN KEY(workspace_id,service_id) REFERENCES escalator_service(workspace_id,id),
 FOREIGN KEY(workspace_id,environment_id) REFERENCES escalator_environment(workspace_id,id),
 FOREIGN KEY(workspace_id,model_secret_id) REFERENCES escalator_secret(workspace_id,id),
 CHECK(jsonb_typeof(data)='object' AND octet_length(data::text)<=32768 AND NOT(data ? 'sources')),
 CHECK(data->'profile'->>'id' IS NOT NULL AND data->'profile'->>'id'=id),
 CHECK((data->'profile'->>'revision')::bigint IS NOT NULL AND (data->'profile'->>'revision')::bigint=revision),
 CHECK((data->>'enabled')::boolean IS NOT NULL AND (data->>'enabled')::boolean=enabled),
 CHECK(data->'profile'->'scope'->>'serviceId' IS NOT NULL AND data->'profile'->'scope'->>'serviceId'=service_id),
 CHECK(data->'profile'->'scope'->>'environmentId' IS NOT NULL AND data->'profile'->'scope'->>'environmentId'=environment_id),
 CHECK(NOT(data->'profile'->'scope' ? 'workspaceId')),
 CHECK(model_secret_id IS NOT DISTINCT FROM (data->'profile'->>'secretId'))
);
CREATE TABLE escalator_investigation_source_link (
 workspace_id text COLLATE "C" NOT NULL,
 profile_id text COLLATE "C" NOT NULL,
 position integer NOT NULL CHECK(position BETWEEN 0 AND 31),
 kind text COLLATE "C" NOT NULL CHECK(kind IN ('probe','alert','metric','log','deployment','git_diff')),
 source_id text COLLATE "C" NOT NULL,
 lookback_ms integer NOT NULL CHECK(lookback_ms BETWEEN 1000 AND 86400000),
 result_limit integer NOT NULL CHECK(result_limit BETWEEN 1 AND 100),
 PRIMARY KEY(workspace_id,profile_id,kind,source_id),
 UNIQUE(workspace_id,profile_id,position),
 FOREIGN KEY(workspace_id,profile_id) REFERENCES escalator_investigation_settings(workspace_id,id)
);
ALTER TABLE escalator_investigation_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_investigation_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_investigation_settings_scope ON escalator_investigation_settings
 USING(workspace_id=current_setting('app.workspace_id',true))
 WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
ALTER TABLE escalator_investigation_source_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_investigation_source_link FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_investigation_source_link_scope ON escalator_investigation_source_link
 USING(workspace_id=current_setting('app.workspace_id',true))
 WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
