CREATE INDEX escalator_retention_retired_work
ON escalator_job(workspace_id,kind,completed_at,id);
