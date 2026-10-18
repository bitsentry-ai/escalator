import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  detectionConformance,
  seedDetectionFixture,
  detectionRows,
} from "@escalator-test/detection";
import { workspaceIdSchema } from "@bitsentry-escalator/features/contracts";
import { readMigrations } from "../../src/platform/database/migrate.js";
import { PostgresDetectionRepository } from "../../src/platform/database/detection.repository.js";
import { PostgresWorkStore } from "../../src/platform/jobs/postgres-work.store.js";
import { postgresFixture, testDatabaseConfigured } from "./postgres-fixture.js";
const options = testDatabaseConfigured()
  ? {}
  : {
      skip: "Not runtime-verified: configure both explicit disposable PostgreSQL test variables",
    };
const create = async () =>
  postgresFixture(await readMigrations(resolve("migrations")));
detectionConformance(
  "standalone PostgreSQL detection",
  async () => {
    const fixture = await create();
    return {
      repository: new PostgresDetectionRepository(fixture.app),
      work: new PostgresWorkStore(fixture.app),
      dispose: () => fixture.dispose(),
    };
  },
  options,
);
test(
  "populated detection tables hide foreign rows and immutable processing receipts deny updates",
  options,
  async () => {
    const fixture = await create();
    try {
      const repo = new PostgresDetectionRepository(fixture.app);
      const scope = workspaceIdSchema.parse("detection_rls");
      await repo.transaction(scope, async (tx) => {
        await seedDetectionFixture(tx);
        const { alert, group } = await detectionRows(tx);
        await tx.detection.lockGroup(group.id);
        await tx.detection.putGroup(group, null);
        await tx.detection.putAlert(alert);
        await tx.detection.recordProcessed({
          id: "event",
          workspaceId: scope,
          sourceId: "source",
          incidentId: null,
          disposition: "active",
          recordedAt: tx.now,
        });
        await tx.detection.putBinding(
          {
            id: "binding",
            workspaceId: scope,
            serviceId: alert.serviceId,
            environmentId: alert.environmentId,
            enabled: false,
            policyId: null,
            version: 1,
            createdAt: tx.now,
            updatedAt: tx.now,
          },
          null,
        );
      });
      const connection = await fixture.app.connect();
      try {
        for (const workspace of ["", "foreign", scope]) {
          await connection.query("BEGIN");
          await connection.query(
            "SELECT set_config('app.workspace_id',$1,true)",
            [workspace],
          );
          for (const kind of ["binding", "group", "alert", "processed"]) {
            const result = await connection.query(
              `SELECT id FROM escalator_detection_${kind}`,
            );
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
          connection.query(
            "UPDATE escalator_detection_processed SET data=data",
          ),
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
test(
  "binding creation and version updates have one winner on the service/environment key",
  options,
  async () => {
    const fixture = await create();
    try {
      const repo = new PostgresDetectionRepository(fixture.app);
      const scope = workspaceIdSchema.parse("detection_binding");
      await repo.transaction(scope, seedDetectionFixture);
      const createBinding = (id: string) =>
        repo.transaction(scope, async (tx) => {
          const { alert } = await detectionRows(tx);
          return tx.detection.putBinding(
            {
              id,
              workspaceId: scope,
              serviceId: alert.serviceId,
              environmentId: alert.environmentId,
              enabled: false,
              policyId: null,
              version: 1,
              createdAt: tx.now,
              updatedAt: tx.now,
            },
            null,
          );
        });
      assert.equal(
        (
          await Promise.all([createBinding("first"), createBinding("second")])
        ).filter(Boolean).length,
        1,
      );
      const current = await repo.transaction(scope, (tx) =>
        tx.detection.binding("api", "prod"),
      );
      assert.ok(current);
      const update = () =>
        repo.transaction(scope, (tx) =>
          tx.detection.putBinding(
            { ...current, version: 2, updatedAt: tx.now },
            1,
          ),
        );
      assert.equal(
        (await Promise.all([update(), update()])).filter(Boolean).length,
        1,
      );
    } finally {
      await fixture.dispose();
    }
  },
);
