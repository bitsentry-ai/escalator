-- Draft: validate with opt-in PostgreSQL fixtures before claiming runtime proof.
-- The investigation ID is also its durable job ID. Network work starts after claim commit.
CREATE UNIQUE INDEX escalator_job_kind_binding ON escalator_job(workspace_id,id,kind);
CREATE TABLE escalator_investigation (
 workspace_id text NOT NULL REFERENCES escalator_workspace(id),
 id text COLLATE "C" NOT NULL,
 job_kind text NOT NULL DEFAULT 'investigation.run' CHECK(job_kind='investigation.run'),
 incident_id text COLLATE "C" NOT NULL,
 service_id text COLLATE "C" NOT NULL,
 environment_id text COLLATE "C" NOT NULL,
 profile_id text COLLATE "C" NOT NULL,
 configuration jsonb NOT NULL,
 limits jsonb NOT NULL,
 sources jsonb NOT NULL,
 runtime_id text COLLATE "C",
 report jsonb,
 created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,id,job_kind) REFERENCES escalator_job(workspace_id,id,kind),
 FOREIGN KEY(workspace_id,incident_id,service_id,environment_id) REFERENCES escalator_incident(workspace_id,id,service_id,environment_id),
 CHECK(updated_at>=created_at),
 CHECK(jsonb_typeof(configuration)='object' AND octet_length(configuration::text)<=262144),
 CHECK(configuration->'profile'->>'id' IS NOT NULL AND configuration->'profile'->>'id'=profile_id),
 CHECK(jsonb_typeof(limits)='object' AND octet_length(limits::text)<=2048),
 CHECK(jsonb_typeof(sources)='array' AND jsonb_array_length(sources)<=32 AND octet_length(sources::text)<=65536),
 CHECK(report IS NULL OR (jsonb_typeof(report)='object' AND octet_length(report::text)<=1048576)),
 CHECK(report IS NULL OR (report->>'id' IS NOT NULL AND report->>'id'=id)),
 CHECK(report IS NULL OR (report->'scope'->>'workspaceId' IS NOT NULL AND report->'scope'->>'workspaceId'=workspace_id)),
 CHECK(report IS NULL OR (report->'scope'->>'incidentId' IS NOT NULL AND report->'scope'->>'incidentId'=incident_id)),
 CHECK(report IS NULL OR (report->'scope'->>'serviceId' IS NOT NULL AND report->'scope'->>'serviceId'=service_id)),
 CHECK(report IS NULL OR (report->'scope'->>'environmentId' IS NOT NULL AND report->'scope'->>'environmentId'=environment_id))
);
CREATE INDEX escalator_investigation_incident ON escalator_investigation(workspace_id,incident_id,created_at,id);
CREATE TABLE escalator_investigation_evidence (
 workspace_id text NOT NULL,
 investigation_id text COLLATE "C" NOT NULL,
 id text COLLATE "C" NOT NULL,
 data jsonb NOT NULL,
 PRIMARY KEY(workspace_id,investigation_id,id),
 FOREIGN KEY(workspace_id,investigation_id) REFERENCES escalator_investigation(workspace_id,id),
 CHECK(jsonb_typeof(data)='object' AND octet_length(data::text)<=131072),
 CHECK(data->'reference'->>'id' IS NOT NULL AND data->'reference'->>'id'=id),
 CHECK(data->'scope'->>'workspaceId' IS NOT NULL AND data->'scope'->>'workspaceId'=workspace_id)
);
CREATE TABLE escalator_investigation_trace (
 workspace_id text NOT NULL,
 investigation_id text COLLATE "C" NOT NULL,
 attempt integer NOT NULL CHECK(attempt BETWEEN 1 AND 5),
 sequence integer NOT NULL CHECK(sequence BETWEEN 0 AND 127),
 data jsonb NOT NULL,
 PRIMARY KEY(workspace_id,investigation_id,attempt,sequence),
 FOREIGN KEY(workspace_id,investigation_id) REFERENCES escalator_investigation(workspace_id,id),
 CHECK(jsonb_typeof(data)='object' AND octet_length(data::text)<=65536),
 CHECK(data->>'sequence' IS NOT NULL AND (data->>'sequence')::integer=sequence)
);
DO $$
DECLARE relation text;
BEGIN
 FOREACH relation IN ARRAY ARRAY['escalator_investigation','escalator_investigation_evidence','escalator_investigation_trace'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format('CREATE POLICY investigation_read ON %I FOR SELECT USING(workspace_id=current_setting(''app.workspace_id'',true))',relation);
  EXECUTE format('CREATE POLICY investigation_insert ON %I FOR INSERT WITH CHECK(workspace_id=current_setting(''app.workspace_id'',true))',relation);
 END LOOP;
END $$;
CREATE POLICY investigation_update ON escalator_investigation FOR UPDATE USING(workspace_id=current_setting('app.workspace_id',true)) WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
