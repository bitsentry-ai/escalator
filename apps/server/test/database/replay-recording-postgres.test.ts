import { resolve } from "node:path";
import {
  replayCoverageConformance,
  type CoverageFixture,
} from "@escalator-test/replay-coverage";
import { PostgresReplayCoverageRepository } from "../../src/platform/database/coverage.repository.js";
import { replayRecordingConformance } from "@escalator-test/replay-recording";
import { readMigrations } from "../../src/platform/database/migrate.js";
import { PostgresProbeRepository } from "../../src/platform/database/probes.repository.js";
import { PostgresMetricsRepository } from "../../src/platform/database/metrics.repository.js";
import { postgresFixture, testDatabaseConfigured } from "./postgres-fixture.js";
const create = async (recording: boolean): Promise<CoverageFixture> => {
  const all = await readMigrations(resolve("migrations"));
  const prior = all.filter((item) => item.name < "0011_replay_recording.sql");
  const f = await postgresFixture(recording ? all : prior);
  return {
    coverage: new PostgresReplayCoverageRepository(f.app),
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
};
const options = testDatabaseConfigured()
  ? {}
  : {
      skip: "Not runtime-verified: configure both explicit disposable PostgreSQL test variables",
    };
replayRecordingConformance(
  "standalone PostgreSQL replay recording",
  create,
  options,
);
replayCoverageConformance(
  "standalone PostgreSQL replay coverage",
  create,
  options,
);
