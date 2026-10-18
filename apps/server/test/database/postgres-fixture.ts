import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  migrate,
  type Migration,
} from "../../src/platform/database/migrate.js";
import { PostgresFoundationRepository } from "../../src/platform/database/foundation.repository.js";

/** Opt-in only. Never fall back to the application's DATABASE_URL. */
export function testDatabaseConfigured(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const admin = environment.ESCALATOR_TEST_MIGRATION_DATABASE_URL;
  const app = environment.ESCALATOR_TEST_DATABASE_URL;
  if (Boolean(admin) !== Boolean(app))
    throw new Error(
      "Configure both Escalator test database variables or neither",
    );
  return Boolean(admin && app);
}
/** node-postgres URL options override Pool options: put the random scope in the URL. */
export function scopedTestUrl(value: string, schema: string): string {
  if (!/^escalator_test_[a-f0-9]{32}$/.test(schema))
    throw new Error("Invalid test schema");
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw new Error("Expected a PostgreSQL URL");
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

export async function postgresFixture(
  migrations: readonly Migration[],
  options: {
    replayAccountingDeletes?: boolean;
    coverageMutationPrivileges?: boolean;
    baselineMutationPrivileges?: boolean;
    replayPruningDeletes?: boolean;
    labelMutationPrivileges?: boolean;
  } = {},
) {
  if (!testDatabaseConfigured())
    throw new Error("No explicitly configured Escalator test database");
  const schema = `escalator_test_${randomUUID().replaceAll("-", "")}`;
  const migrationUrl = process.env.ESCALATOR_TEST_MIGRATION_DATABASE_URL!;
  const appUrl = process.env.ESCALATOR_TEST_DATABASE_URL!;
  // Random, internally generated schema; connection options never interpolate user input.
  const admin = new Pool({
    connectionString: scopedTestUrl(migrationUrl, schema),
    connectionTimeoutMillis: 5000,
  });
  const app = new Pool({
    connectionString: scopedTestUrl(appUrl, schema),
    connectionTimeoutMillis: 5000,
  });
  let created = false;
  try {
    const role = await app.query<{
      role: string;
      bypass: boolean;
      superuser: boolean;
      database: string;
    }>(
      "SELECT current_user AS role, rolbypassrls AS bypass, rolsuper AS superuser, current_database() AS database FROM pg_roles WHERE rolname = current_user",
    );
    const current = role.rows[0];
    const owner = await admin.query<{ role: string; database: string }>(
      "SELECT current_user AS role, current_database() AS database",
    );
    const membership = await app.query<{ member: boolean }>(
      "SELECT pg_has_role(current_user, $1::name, 'MEMBER') AS member",
      [owner.rows[0].role],
    );
    if (
      membership.rows[0].member ||
      current.bypass ||
      current.superuser ||
      current.role === owner.rows[0].role ||
      current.database !== owner.rows[0].database
    ) {
      throw new Error(
        "Conformance requires distinct migration and restricted non-BYPASSRLS application roles on the same disposable database",
      );
    }
    await admin.query(`CREATE SCHEMA ${identifier(schema)}`);
    created = true;
    console.info(`Escalator disposable test schema: ${schema}`);
    await migrate(admin, migrations);
    // Rerunning identical migrations must succeed without changing the journal.
    const before = await admin.query(
      "SELECT name, checksum, applied_at FROM escalator_migration ORDER BY name",
    );
    await migrate(admin, migrations);
    const after = await admin.query(
      "SELECT name, checksum, applied_at FROM escalator_migration ORDER BY name",
    );
    if (JSON.stringify(before.rows) !== JSON.stringify(after.rows))
      throw new Error("Migration rerun changed the journal");
    await admin.query(
      `GRANT USAGE ON SCHEMA ${identifier(schema)} TO ${identifier(current.role)}`,
    );
    for (const table of [
      "escalator_workspace",
      "escalator_service",
      "escalator_environment",
      "escalator_audit",
      "escalator_signal_event",
      "escalator_detection_processed",
      "escalator_probe_result",
      "escalator_heartbeat_receipt",
      "escalator_metric_version",
      "escalator_metric_observation",
    ]) {
      await admin.query(
        `GRANT SELECT, INSERT ON ${identifier(table)} TO ${identifier(current.role)}`,
      );
    }
    for (const table of [
      "escalator_detection_binding",
      "escalator_probe",
      "escalator_probe_state",
      "escalator_probe_schedule",
      "escalator_heartbeat_probe",
      "escalator_metric_monitor",
      "escalator_metric_schedule",
      "escalator_heartbeat_state",
      "escalator_heartbeat_grant",
      "escalator_detection_group",
      "escalator_detection_alert",
      "escalator_signal_source",
      "escalator_signal_token",
      "escalator_schedule",
      "escalator_policy",
      "escalator_contact",
      "escalator_availability",
      "escalator_schedule_preview",
      "escalator_incident",
      "escalator_page",
      "escalator_page_step",
      "escalator_delivery",
      "escalator_delivery_attempt",
      "escalator_ack_grant",
      "escalator_responder",
      "escalator_job",
      "escalator_outbox",
      "escalator_secret",
      "escalator_account",
      "escalator_auth_token",
      "escalator_recovery_code",
      "escalator_session",
      "escalator_auth_rate",
    ]) {
      await admin.query(
        `GRANT SELECT, INSERT, UPDATE ON ${identifier(table)} TO ${identifier(current.role)}`,
      );
    }
    if (migrations.some((item) => item.name === "0016_deployments.sql")) {
      for (const table of [
        "escalator_deploy_target",
        "escalator_deploy_grant",
        "escalator_deployment",
      ])
        await admin.query(
          `GRANT SELECT,INSERT,UPDATE ON ${identifier(table)} TO ${identifier(current.role)}`,
        );
      await admin.query(
        `GRANT SELECT,INSERT ON escalator_deploy_receipt TO ${identifier(current.role)}`,
      );
    }
    const grantCoverage = async (list: readonly Migration[]) => {
      if (list.some((item) => item.name === "0017_deployment_coverage.sql")) {
        await admin.query(
          `GRANT SELECT,INSERT${options.coverageMutationPrivileges ? ",UPDATE,DELETE" : ""} ON escalator_coverage_decision TO ${identifier(current.role)}`,
        );
      }
    };
    await grantCoverage(migrations);
    const grantBaselines = async (list: readonly Migration[]) => {
      if (!list.some((item) => item.name === "0018_deployment_baselines.sql"))
        return;
      await admin.query(
        `GRANT SELECT,INSERT${options.baselineMutationPrivileges ? ",UPDATE,DELETE" : ""} ON escalator_deployment_baseline TO ${identifier(current.role)}`,
      );
      await admin.query(
        `GRANT SELECT,INSERT,DELETE${options.baselineMutationPrivileges ? ",UPDATE" : ""} ON escalator_deployment_pin TO ${identifier(current.role)}`,
      );
    };
    await grantBaselines(migrations);
    const grantWatches = async (list: readonly Migration[]) => {
      if (list.some((item) => item.name === "0019_deployment_watches.sql"))
        await admin.query(
          `GRANT SELECT,INSERT,UPDATE ON escalator_deployment_watch TO ${identifier(current.role)}`,
        );
    };
    await grantWatches(migrations);
    const grantCadence = async (list: readonly Migration[]) => {
      if (!list.some((item) => item.name === "0020_watch_cadence.sql")) return;
      await admin.query(
        `GRANT SELECT,INSERT,UPDATE,DELETE ON escalator_watch_cadence_lease TO ${identifier(current.role)}`,
      );
      await admin.query(
        `GRANT SELECT,INSERT ON escalator_watch_cadence_receipt TO ${identifier(current.role)}`,
      );
    };
    await grantCadence(migrations);
    const grantInvestigations = async (list: readonly Migration[]) => {
      if (list.some((item) => item.name === "0021_investigations.sql")) {
        await admin.query(
          `GRANT SELECT,INSERT,UPDATE ON escalator_investigation TO ${identifier(current.role)}`,
        );
        await admin.query(
          `GRANT SELECT,INSERT ON escalator_investigation_evidence,escalator_investigation_trace TO ${identifier(current.role)}`,
        );
      }
    };
    await grantInvestigations(migrations);
    const grantInvestigationSettings = async (list: readonly Migration[]) => {
      if (
        list.some((item) => item.name === "0022_investigation_settings.sql")
      ) {
        await admin.query(
          `GRANT SELECT,INSERT,UPDATE ON escalator_investigation_settings TO ${identifier(current.role)}`,
        );
        await admin.query(
          `GRANT SELECT,INSERT,UPDATE,DELETE ON escalator_investigation_source_link TO ${identifier(current.role)}`,
        );
      }
    };
    await grantInvestigationSettings(migrations);
    const grantLabels = async (list: readonly Migration[]) => {
      if (list.some((item) => item.name === "0023_incident_labels.sql"))
        await admin.query(
          `GRANT SELECT,INSERT,UPDATE${options.labelMutationPrivileges ? ",DELETE" : ""} ON escalator_incident_label TO ${identifier(current.role)}`,
        );
    };
    await grantLabels(migrations);
    const grantRules = async (list: readonly Migration[]) => {
      const has = (name: string) => list.some((item) => item.name === name);
      const grant = async (privileges: string, tables: string) => {
        await admin.query(
          `GRANT ${privileges} ON ${tables} TO ${identifier(current.role)}`,
        );
      };
      if (has("0024_rule_runtime.sql")) {
        await grant(
          "SELECT,INSERT",
          "escalator_rule_version,escalator_rule_decision",
        );
        await grant("SELECT,INSERT,UPDATE", "escalator_rule_runtime");
      }
      if (has("0025_rule_policy_history.sql")) {
        await grant("SELECT,INSERT", "escalator_rule_policy_fact");
        await grant(
          "USAGE,SELECT",
          "SEQUENCE escalator_rule_policy_fact_id_seq",
        );
        // Locking SELECTs require UPDATE on at least one selected table column.
        await grant("UPDATE(id)", "escalator_service");
      }
      if (has("0026_rule_replay.sql")) {
        await grant(
          "SELECT,INSERT",
          "escalator_rule_replay_snapshot,escalator_rule_replay_chunk",
        );
        await grant("SELECT,INSERT,UPDATE", "escalator_rule_replay_run");
      }
      if (has("0027_rule_backtest.sql"))
        await grant("SELECT,INSERT", "escalator_rule_backtest");
      if (has("0029_rule_proposals.sql"))
        await grant("SELECT,INSERT,UPDATE", "escalator_rule_proposal");
      if (has("0031_rule_catalog.sql")) {
        await grant("SELECT,INSERT,UPDATE", "escalator_rule_catalog");
        await grant("SELECT,INSERT,UPDATE,DELETE", "escalator_rule_review");
        await grant("SELECT,INSERT", "escalator_rule_activation");
      }
    };
    await grantRules(migrations);
    // Ensure both URLs reach this exact schema, not separate servers with equal database names.
    const grantRecording = async (list: readonly Migration[]) => {
      if (!list.some((item) => item.name === "0011_replay_recording.sql"))
        return;
      for (const table of [
        "escalator_source_version",
        "escalator_probe_version",
      ])
        await admin.query(
          `GRANT SELECT, INSERT ON ${identifier(table)} TO ${identifier(current.role)}`,
        );
    };
    const grantAccounting = async (list: readonly Migration[]) => {
      if (!list.some((item) => item.name === "0012_retention_accounting.sql"))
        return;
      for (const table of [
        "escalator_retention_policy",
        "escalator_replay_usage",
      ])
        await admin.query(
          `GRANT SELECT,INSERT,UPDATE ON ${identifier(table)} TO ${identifier(current.role)}`,
        );
      await admin.query(
        `GRANT SELECT,INSERT ON escalator_signal_tombstone TO ${identifier(current.role)}`,
      );
      // Only accounting fixtures exercise raw DELETE; ordinary producer fixtures retain INSERT-only receipts.
      if (options.replayAccountingDeletes || options.replayPruningDeletes)
        for (const table of [
          "escalator_signal_event",
          "escalator_probe_result",
          "escalator_metric_observation",
        ])
          await admin.query(
            `GRANT DELETE ON ${identifier(table)} TO ${identifier(current.role)}`,
          );
    };
    if (options.replayPruningDeletes)
      for (const table of ["escalator_job", "escalator_detection_processed"])
        await admin.query(
          `GRANT DELETE ON ${identifier(table)} TO ${identifier(current.role)}`,
        );
    const grantMaintenance = async (list: readonly Migration[]) => {
      if (list.some((item) => item.name === "0014_retention_schedule.sql"))
        await admin.query(
          `GRANT SELECT,INSERT,UPDATE ON escalator_retention_schedule TO ${identifier(current.role)}`,
        );
    };
    await grantMaintenance(migrations);
    await grantRecording(migrations);
    await grantAccounting(migrations);
    await app.query("SELECT id FROM escalator_workspace LIMIT 0");
    return {
      repository: new PostgresFoundationRepository(app),
      app,
      async upgrade(next: readonly Migration[]) {
        await migrate(admin, next);
        await grantCoverage(next);
        await grantBaselines(next);
        await grantWatches(next);
        await grantCadence(next);
        await grantInvestigations(next);
        await grantInvestigationSettings(next);
        await grantLabels(next);
        await grantRules(next);
        await grantRecording(next);
        await grantAccounting(next);
        await grantMaintenance(next);
      },
      async dispose() {
        try {
          await app.end();
        } finally {
          try {
            await admin.query(`DROP SCHEMA ${identifier(schema)} CASCADE`);
          } finally {
            await admin.end();
          }
        }
      },
    };
  } catch (error) {
    try {
      await app.end();
    } finally {
      try {
        if (created)
          await admin.query(`DROP SCHEMA ${identifier(schema)} CASCADE`);
      } finally {
        await admin.end();
      }
    }
    throw error;
  }
}
