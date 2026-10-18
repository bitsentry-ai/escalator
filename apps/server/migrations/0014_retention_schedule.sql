-- source_id is a scoped traversal hint, not a foreign key: advancing it must
-- not acquire a second source KEY SHARE lock after byte accounting.
CREATE TABLE escalator_retention_schedule (
  workspace_id text PRIMARY KEY REFERENCES escalator_workspace(id),
  revision bigint NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
  current_job_id text COLLATE "C" NOT NULL,
  due_at timestamptz NOT NULL,
  source_id text COLLATE "C",
  receipt_cursor jsonb,
  sweep_started_at timestamptz,
  completed_at timestamptz,
  FOREIGN KEY(workspace_id,current_job_id) REFERENCES escalator_job(workspace_id,id),
  CHECK(source_id IS NOT NULL OR receipt_cursor IS NULL),
  CHECK(source_id IS NULL OR sweep_started_at IS NOT NULL),
  CHECK(receipt_cursor IS NULL OR jsonb_typeof(receipt_cursor)='object')
);
ALTER TABLE escalator_retention_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_retention_schedule FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON escalator_retention_schedule
USING (workspace_id=nullif(current_setting('app.workspace_id',true),''))
WITH CHECK (workspace_id=nullif(current_setting('app.workspace_id',true),''));
