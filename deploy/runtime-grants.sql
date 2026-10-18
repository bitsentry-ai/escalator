-- Run as the owning migration role after applying the complete migration chain.
-- Supply the restricted application's role name with psql -v app_role=escalator_app.
-- No role membership, ownership, schema CREATE, or RLS bypass is granted.
\set ON_ERROR_STOP on
BEGIN;
SELECT set_config('escalator.grant_role', :'app_role', true);
DO $role_check$
DECLARE target pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO target FROM pg_roles WHERE rolname=current_setting('escalator.grant_role');
  IF NOT FOUND OR NOT target.rolcanlogin OR target.rolsuper OR target.rolbypassrls
     OR target.rolcreaterole OR target.rolcreatedb OR target.rolreplication THEN
    RAISE EXCEPTION 'Application role must be an existing restricted login';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members WHERE member=target.oid)
     OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner=target.oid)
     OR EXISTS (SELECT 1 FROM pg_class WHERE relowner=target.oid) THEN
    RAISE EXCEPTION 'Application role must have no memberships or object ownership';
  END IF;
END;
$role_check$;
GRANT USAGE ON SCHEMA public TO :"app_role";
GRANT SELECT, INSERT ON
  escalator_workspace, escalator_service, escalator_environment, escalator_audit,
  escalator_signal_event, escalator_detection_processed, escalator_probe_result,
  escalator_heartbeat_receipt, escalator_metric_version, escalator_metric_observation,
  escalator_deploy_receipt, escalator_coverage_decision, escalator_deployment_baseline,
  escalator_watch_cadence_receipt, escalator_investigation_evidence,
  escalator_investigation_trace, escalator_rule_version, escalator_rule_decision,
  escalator_rule_policy_fact, escalator_rule_replay_snapshot, escalator_rule_replay_chunk,
  escalator_rule_backtest, escalator_rule_activation, escalator_source_version,
  escalator_probe_version, escalator_signal_tombstone
  TO :"app_role";
GRANT SELECT, INSERT, UPDATE ON
  escalator_detection_binding, escalator_probe, escalator_probe_state, escalator_probe_schedule,
  escalator_heartbeat_probe, escalator_metric_monitor, escalator_metric_schedule,
  escalator_heartbeat_state, escalator_heartbeat_grant, escalator_detection_group,
  escalator_detection_alert, escalator_signal_source, escalator_signal_token,
  escalator_schedule, escalator_policy, escalator_contact, escalator_availability,
  escalator_schedule_preview, escalator_incident, escalator_page, escalator_page_step,
  escalator_delivery, escalator_delivery_attempt, escalator_ack_grant, escalator_responder,
  escalator_job, escalator_outbox, escalator_secret, escalator_account, escalator_auth_token,
  escalator_recovery_code, escalator_session, escalator_auth_rate, escalator_deploy_target,
  escalator_deploy_grant, escalator_deployment, escalator_deployment_watch,
  escalator_investigation, escalator_investigation_settings, escalator_incident_label,
  escalator_rule_runtime, escalator_rule_replay_run, escalator_rule_proposal,
  escalator_rule_catalog, escalator_retention_policy, escalator_replay_usage,
  escalator_retention_schedule
  TO :"app_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON
  escalator_watch_cadence_lease, escalator_investigation_source_link, escalator_rule_review
  TO :"app_role";
GRANT SELECT, INSERT, DELETE ON escalator_deployment_pin TO :"app_role";
-- Guarded retention and retired-work cleanup need DELETE; receipt UPDATE stays denied.
GRANT DELETE ON escalator_signal_event, escalator_probe_result,
  escalator_metric_observation, escalator_job, escalator_detection_processed TO :"app_role";
-- SELECT FOR UPDATE/FOR SHARE requires UPDATE on at least one column.
GRANT UPDATE(id) ON escalator_workspace, escalator_service, escalator_environment TO :"app_role";
GRANT USAGE, SELECT ON SEQUENCE escalator_rule_policy_fact_id_seq TO :"app_role";
GRANT SELECT, UPDATE(id) ON escalator_compatibility TO :"app_role";
GRANT SELECT ON escalator_migration TO :"app_role";
COMMIT;
