import { resolve } from "node:path";
import { retentionPruningConformance } from "@escalator-test/retention-pruning";
import { readMigrations } from "../../src/platform/database/migrate.js";
import { PostgresReplayPruneRepository } from "../../src/platform/database/retention-prune.repository.js";
import { PostgresDetectionRepository } from "../../src/platform/database/detection.repository.js";
import { PostgresProbeRepository } from "../../src/platform/database/probes.repository.js";
import { PostgresMetricsRepository } from "../../src/platform/database/metrics.repository.js";
import { postgresFixture, testDatabaseConfigured } from "./postgres-fixture.js";
retentionPruningConformance(
  "standalone PostgreSQL retention pruning",
  async () => {
    const all = await readMigrations(resolve("migrations"));
    const f = await postgresFixture(all, { replayPruningDeletes: true });
    return {
      probes: new PostgresProbeRepository(f.app),
      metrics: new PostgresMetricsRepository(f.app),
      pruning: new PostgresReplayPruneRepository(f.app),
      detection: new PostgresDetectionRepository(f.app),
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
      dispose: () => f.dispose(),
    };
  },
  testDatabaseConfigured()
    ? {}
    : {
        skip: "Not runtime-verified: configure both explicit disposable PostgreSQL test variables",
      },
);
