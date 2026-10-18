import { resolve } from "node:path";
import { retentionAccountingConformance } from "@escalator-test/retention-accounting";
import { readMigrations } from "../../src/platform/database/migrate.js";
import { PostgresRetentionPolicyRepository } from "../../src/platform/database/retention-policy.repository.js";
import { PostgresProbeRepository } from "../../src/platform/database/probes.repository.js";
import { PostgresMetricsRepository } from "../../src/platform/database/metrics.repository.js";
import { postgresFixture, testDatabaseConfigured } from "./postgres-fixture.js";
retentionAccountingConformance(
  "standalone PostgreSQL retention accounting",
  async (accounting) => {
    const all = await readMigrations(resolve("migrations"));
    const f = await postgresFixture(
      accounting
        ? all
        : all.filter((row) => row.name < "0012_retention_accounting.sql"),
      { replayAccountingDeletes: true },
    );
    return {
      policies: new PostgresRetentionPolicyRepository(f.app),
      probes: new PostgresProbeRepository(f.app),
      metrics: new PostgresMetricsRepository(f.app),
      async query(scope, sql, values = []) {
        const connection = await f.app.connect();
        try {
          await connection.query("BEGIN");
          await connection.query(
            "SELECT set_config('app.workspace_id',$1,true)",
            [scope],
          );
          const result = await connection.query(
            sql.replaceAll("__scope__", "workspace_id"),
            values,
          );
          await connection.query("COMMIT");
          return result.rows;
        } catch (error) {
          await connection.query("ROLLBACK");
          throw error;
        } finally {
          connection.release();
        }
      },
      upgrade: () => f.upgrade(all),
      dispose: () => f.dispose(),
    };
  },
  testDatabaseConfigured()
    ? {}
    : {
        skip: "Not runtime-verified: configure both explicit disposable PostgreSQL test variables",
      },
);
