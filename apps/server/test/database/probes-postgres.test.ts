import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { probeConformance, seedProbeFixture } from "@escalator-test/probes";
import {
  workspaceIdSchema,
  probeResultSchema,
} from "@bitsentry-escalator/features/contracts";
import {
  observeProbe,
  probeJobId,
} from "@bitsentry-escalator/features/application";
import { readMigrations } from "../../src/platform/database/migrate.js";
import { PostgresProbeRepository } from "../../src/platform/database/probes.repository.js";
import { PostgresWorkStore } from "../../src/platform/jobs/postgres-work.store.js";
import { postgresFixture, testDatabaseConfigured } from "./postgres-fixture.js";
const options = testDatabaseConfigured()
  ? {}
  : {
      skip: "Not runtime-verified: configure both explicit disposable PostgreSQL test variables",
    };
const create = async () =>
  postgresFixture(await readMigrations(resolve("migrations")));
probeConformance(
  "standalone PostgreSQL probes",
  async () => {
    const fixture = await create();
    return {
      repository: new PostgresProbeRepository(fixture.app),
      work: new PostgresWorkStore(fixture.app),
      dispose: () => fixture.dispose(),
    };
  },
  options,
);
test(
  "populated probe tables enforce scope and observation receipts reject updates",
  options,
  async () => {
    const fixture = await create();
    try {
      const repository = new PostgresProbeRepository(fixture.app);
      const scope = workspaceIdSchema.parse("probe_rls");
      await repository.transaction(scope, async (tx) => {
        const probe = await seedProbeFixture(tx);
        const result = probeResultSchema.parse({
          id: "run",
          workspaceId: scope,
          probeId: probe.id,
          probeVersion: 1,
          observedAt: tx.now,
          outcome: "failed",
          reason: "timeout",
          statusCode: null,
          durationMs: 1000,
        });
        await tx.probes.recordResult(result);
        const decision = observeProbe(probe, undefined, result);
        assert.ok("state" in decision);
        await tx.probes.putState(decision.state);
        await tx.probes.putSchedule({
          probeId: probe.id,
          workspaceId: scope,
          probeVersion: 1,
          jobId: probeJobId(scope, probe.id, 1, tx.now),
          dueAt: tx.now,
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
          for (const table of [
            "escalator_probe",
            "escalator_probe_result",
            "escalator_probe_state",
            "escalator_probe_schedule",
          ]) {
            const result = await connection.query(`SELECT data FROM ${table}`);
            assert.equal(result.rowCount, workspace === scope ? 1 : 0);
          }
          await connection.query("COMMIT");
        }
        await connection.query("BEGIN");
        await connection.query(
          "SELECT set_config('app.workspace_id',$1,true)",
          [scope],
        );
        await assert.rejects(
          connection.query("UPDATE escalator_probe_result SET data=data"),
          { code: "42501" },
        );
        await connection.query("ROLLBACK");
      } finally {
        await connection.query("ROLLBACK");
        connection.release();
      }
    } finally {
      await fixture.dispose();
    }
  },
);
