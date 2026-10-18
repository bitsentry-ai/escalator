-- Runtime credentials receive SELECT/INSERT only on version and observation receipts.
CREATE TABLE escalator_metric_monitor (
 workspace_id text NOT NULL REFERENCES escalator_workspace(id),
 id text COLLATE "C" NOT NULL,
 source_id text NOT NULL,
 service_id text NOT NULL,
 environment_id text NOT NULL,
 auth_secret_id text,
 version bigint NOT NULL CHECK(version>0),
 data jsonb NOT NULL,
 PRIMARY KEY(workspace_id,id),
 UNIQUE(workspace_id,source_id),
 FOREIGN KEY(workspace_id,source_id) REFERENCES escalator_signal_source(workspace_id,id),
 FOREIGN KEY(workspace_id,service_id) REFERENCES escalator_service(workspace_id,id),
 FOREIGN KEY(workspace_id,environment_id) REFERENCES escalator_environment(workspace_id,id),
 FOREIGN KEY(workspace_id,auth_secret_id) REFERENCES escalator_secret(workspace_id,id),
 CHECK(auth_secret_id IS NOT DISTINCT FROM (data->'query'->'connection'->>'authSecretId'))
);
CREATE TABLE escalator_metric_version (
 workspace_id text NOT NULL REFERENCES escalator_workspace(id),
 monitor_id text COLLATE "C" NOT NULL,
 version bigint NOT NULL CHECK(version>0),
 data jsonb NOT NULL,
 PRIMARY KEY(workspace_id,monitor_id,version),
 FOREIGN KEY(workspace_id,monitor_id) REFERENCES escalator_metric_monitor(workspace_id,id)
);
CREATE TABLE escalator_metric_observation (
 workspace_id text NOT NULL REFERENCES escalator_workspace(id),
 id text COLLATE "C" NOT NULL,
 monitor_id text NOT NULL,
 monitor_version bigint NOT NULL,
 observed_at timestamptz NOT NULL,
 received_at timestamptz NOT NULL,
 data jsonb NOT NULL,
 PRIMARY KEY(workspace_id,id),
 UNIQUE(workspace_id,monitor_id,monitor_version,id),
 FOREIGN KEY(workspace_id,monitor_id,monitor_version) REFERENCES escalator_metric_version(workspace_id,monitor_id,version),
 CHECK(observed_at<=received_at)
);
CREATE TABLE escalator_metric_schedule (
 workspace_id text NOT NULL REFERENCES escalator_workspace(id),
 monitor_id text COLLATE "C" NOT NULL,
 monitor_version bigint NOT NULL,
 job_id text,
 due_at timestamptz,
 last_observation_id text,
 data jsonb NOT NULL,
 PRIMARY KEY(workspace_id,monitor_id),
 FOREIGN KEY(workspace_id,monitor_id,monitor_version) REFERENCES escalator_metric_version(workspace_id,monitor_id,version),
 FOREIGN KEY(workspace_id,monitor_id,monitor_version,last_observation_id) REFERENCES escalator_metric_observation(workspace_id,monitor_id,monitor_version,id),
 CHECK((job_id IS NULL)=(due_at IS NULL)),
 CHECK(job_id IS NOT DISTINCT FROM (data->>'jobId')),
 CHECK(due_at IS NOT DISTINCT FROM (data->>'dueAt')::timestamptz),
 CHECK(last_observation_id IS NOT DISTINCT FROM (data->>'lastObservationId'))
);

ALTER TABLE escalator_metric_monitor ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_metric_monitor FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_metric_monitor_scope ON escalator_metric_monitor
 USING(workspace_id=current_setting('app.workspace_id',true))
 WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
ALTER TABLE escalator_metric_monitor ADD CHECK(jsonb_typeof(data)='object' AND NOT(data ? 'workspaceId'));
ALTER TABLE escalator_metric_monitor ADD CHECK((data->>'id')::text IS NOT NULL AND (data->>'id')::text=id);
ALTER TABLE escalator_metric_monitor ADD CHECK((data->>'sourceId')::text IS NOT NULL AND (data->>'sourceId')::text=source_id);
ALTER TABLE escalator_metric_monitor ADD CHECK((data->>'serviceId')::text IS NOT NULL AND (data->>'serviceId')::text=service_id);
ALTER TABLE escalator_metric_monitor ADD CHECK((data->>'environmentId')::text IS NOT NULL AND (data->>'environmentId')::text=environment_id);
ALTER TABLE escalator_metric_monitor ADD CHECK((data->>'version')::bigint IS NOT NULL AND (data->>'version')::bigint=version);

ALTER TABLE escalator_metric_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_metric_version FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_metric_version_scope ON escalator_metric_version
 USING(workspace_id=current_setting('app.workspace_id',true))
 WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
ALTER TABLE escalator_metric_version ADD CHECK(jsonb_typeof(data)='object' AND NOT(data ? 'workspaceId'));
ALTER TABLE escalator_metric_version ADD CHECK((data->>'id')::text IS NOT NULL AND (data->>'id')::text=monitor_id);
ALTER TABLE escalator_metric_version ADD CHECK((data->>'version')::bigint IS NOT NULL AND (data->>'version')::bigint=version);

ALTER TABLE escalator_metric_observation ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_metric_observation FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_metric_observation_scope ON escalator_metric_observation
 USING(workspace_id=current_setting('app.workspace_id',true))
 WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
ALTER TABLE escalator_metric_observation ADD CHECK(jsonb_typeof(data)='object' AND NOT(data ? 'workspaceId'));
ALTER TABLE escalator_metric_observation ADD CHECK((data->>'id')::text IS NOT NULL AND (data->>'id')::text=id);
ALTER TABLE escalator_metric_observation ADD CHECK((data->>'monitorId')::text IS NOT NULL AND (data->>'monitorId')::text=monitor_id);
ALTER TABLE escalator_metric_observation ADD CHECK((data->>'monitorVersion')::bigint IS NOT NULL AND (data->>'monitorVersion')::bigint=monitor_version);
ALTER TABLE escalator_metric_observation ADD CHECK((data->>'observedAt')::timestamptz IS NOT NULL AND (data->>'observedAt')::timestamptz=observed_at);
ALTER TABLE escalator_metric_observation ADD CHECK((data->>'receivedAt')::timestamptz IS NOT NULL AND (data->>'receivedAt')::timestamptz=received_at);

ALTER TABLE escalator_metric_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_metric_schedule FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_metric_schedule_scope ON escalator_metric_schedule
 USING(workspace_id=current_setting('app.workspace_id',true))
 WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
ALTER TABLE escalator_metric_schedule ADD CHECK(jsonb_typeof(data)='object' AND NOT(data ? 'workspaceId'));
ALTER TABLE escalator_metric_schedule ADD CHECK((data->>'monitorId')::text IS NOT NULL AND (data->>'monitorId')::text=monitor_id);
ALTER TABLE escalator_metric_schedule ADD CHECK((data->>'monitorVersion')::bigint IS NOT NULL AND (data->>'monitorVersion')::bigint=monitor_version);

CREATE INDEX escalator_metric_window ON escalator_metric_observation(workspace_id,monitor_id,monitor_version,observed_at,received_at,id);
CREATE INDEX escalator_metric_history ON escalator_metric_observation(workspace_id,monitor_id,received_at,id);
CREATE INDEX escalator_metric_retention ON escalator_metric_observation(workspace_id,received_at,id);
CREATE INDEX escalator_metric_due ON escalator_metric_schedule(workspace_id,due_at,monitor_id);
