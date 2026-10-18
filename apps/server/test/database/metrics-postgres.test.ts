import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  metricsConformance,
  seedMetricFixture,
  metricFixtureObservation,
} from "@escalator-test/metrics";
import { workspaceIdSchema } from "@bitsentry-escalator/features/contracts";
import {
  metricPointAt,
  metricJobId,
} from "@bitsentry-escalator/features/application";
import { readMigrations } from "../../src/platform/database/migrate.js";
import { PostgresMetricsRepository } from "../../src/platform/database/metrics.repository.js";
import { postgresFixture, testDatabaseConfigured } from "./postgres-fixture.js";
const options = testDatabaseConfigured()
  ? {}
  : {
      skip: "Not runtime-verified: configure both explicit disposable PostgreSQL test variables",
    };
const create = async () =>
  postgresFixture(await readMigrations(resolve("migrations")));
metricsConformance(
  "standalone PostgreSQL metrics",
  async () => {
    const fixture = await create();
    return {
      repository: new PostgresMetricsRepository(fixture.app),
      dispose: () => fixture.dispose(),
    };
  },
  options,
);
test(
  "populated metric tables isolate tenants and version/observation receipts reject updates",
  options,
  async () => {
    const fixture = await create();
    try {
      const repository = new PostgresMetricsRepository(fixture.app),
        scope = workspaceIdSchema.parse("metrics_rls");
      await repository.transaction(scope, async (tx) => {
        const monitor = await seedMetricFixture(tx);
        const receipt = await tx.metrics.observe(
          metricFixtureObservation(
            tx,
            monitor,
            "receipt",
            metricPointAt(tx.now, 60),
          ),
        );
        await tx.metrics.putSchedule({
          workspaceId: scope,
          monitorId: monitor.id,
          monitorVersion: 1,
          jobId: metricJobId(scope, monitor.id, 1, tx.now),
          dueAt: tx.now,
          lastObservationId: receipt.id,
          active: false,
        });
      });
      const connection = await fixture.app.connect();
      try {
        for (const workspace of ["", "foreign", scope]) {
          await connection.query("BEGIN");
          await connection.query(
            "SELECT set_config('app.workspace_id',$1,true)",
            [workspace],
          );
          for (const kind of [
            "monitor",
            "version",
            "observation",
            "schedule",
          ]) {
            const rows = await connection.query(
              `SELECT data FROM escalator_metric_${kind}`,
            );
            assert.equal(rows.rowCount, workspace === scope ? 1 : 0);
          }
          await connection.query("COMMIT");
        }
        for (const kind of ["version", "observation"]) {
          await connection.query("BEGIN");
          await connection.query(
            "SELECT set_config('app.workspace_id',$1,true)",
            [scope],
          );
          await assert.rejects(
            connection.query(`UPDATE escalator_metric_${kind} SET data=data`),
            { code: "42501" },
          );
          await connection.query("ROLLBACK");
        }
      } finally {
        await connection.query("ROLLBACK");
        connection.release();
      }
    } finally {
      await fixture.dispose();
    }
  },
);
