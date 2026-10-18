-- Indexed source-local seeks keep bounded replay pruning off full-history sorts.
CREATE INDEX escalator_probe_prune_seek ON escalator_probe_result(workspace_id,probe_id,observed_at,id);
CREATE INDEX escalator_metric_prune_seek ON escalator_metric_observation(workspace_id,monitor_id,observed_at,id);
CREATE INDEX escalator_alert_prune_reference ON escalator_detection_alert(workspace_id,last_signal_id);
