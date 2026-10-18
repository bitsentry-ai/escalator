import { randomUUID } from "node:crypto";
import { serviceEnvironmentSchema } from "@bitsentry-escalator/features/contracts";
import { resolve } from "node:path";
import type { WorkspaceId } from "@bitsentry-escalator/features/contracts";
import { ruleCatalogConformance } from "@escalator-test/rule-catalog";
import { seedRuleLabelStream } from "@escalator-test/rule-label-seed";
import { PostgresRuleCatalogRepository } from "../../src/platform/database/rule-catalog.repository.js";
import { PostgresSignalRepository } from "../../src/platform/database/signals.repository.js";
import { PostgresProbeRepository } from "../../src/platform/database/probes.repository.js";
import { PostgresMetricsRepository } from "../../src/platform/database/metrics.repository.js";
import { readMigrations } from "../../src/platform/database/migrate.js";
import { postgresFixture, testDatabaseConfigured } from "./postgres-fixture.js";
ruleCatalogConformance(
  "standalone PostgreSQL rule catalog",
  async () => {
    const database = await postgresFixture(
      await readMigrations(resolve("migrations")),
    );
    const streams = {
      signals: new PostgresSignalRepository(database.app),
      probes: new PostgresProbeRepository(database.app),
      metrics: new PostgresMetricsRepository(database.app),
    };
    return {
      repository: new PostgresRuleCatalogRepository(database.app),
      foundation: database.repository,
      seedStream: (stream: Parameters<typeof seedRuleLabelStream>[1]) =>
        seedRuleLabelStream(streams, stream),
      async queued(scope: WorkspaceId) {
        const db = await database.app.connect();
        try {
          await db.query("BEGIN");
          await db.query("SELECT set_config('app.workspace_id',$1,true)", [
            scope,
          ]);
          const r = await db.query<{ n: number }>(
            "SELECT count(*)::integer AS n FROM escalator_job WHERE workspace_id=$1 AND kind='rules.evaluate'",
            [scope],
          );
          await db.query("COMMIT");
          return r.rows[0]!.n;
        } catch (error) {
          await db.query("ROLLBACK");
          throw error;
        } finally {
          db.release();
        }
      },
      async insertBinding(stream: Parameters<typeof seedRuleLabelStream>[1]) {
        const now = new Date().toISOString();
        const row = serviceEnvironmentSchema.parse({
          id: randomUUID(),
          workspaceId: stream.workspaceId,
          serviceId: stream.serviceId,
          environmentId: stream.environmentId,
          version: 1,
          enabled: false,
          policyId: null,
          createdAt: now,
          updatedAt: now,
        });
        const db = await database.app.connect();
        try {
          await db.query("BEGIN");
          await db.query("SELECT set_config('app.workspace_id',$1,true)", [
            stream.workspaceId,
          ]);
          await db.query("SET LOCAL lock_timeout = '100ms'");
          await db.query(
            "INSERT INTO escalator_detection_binding(workspace_id,id,service_id,environment_id,policy_id,version,data) VALUES($1,$2,$3,$4,NULL,1,$5::jsonb)",
            [
              stream.workspaceId,
              row.id,
              row.serviceId,
              row.environmentId,
              JSON.stringify(row, (key, value: unknown) =>
                key === "workspaceId" ? undefined : value,
              ),
            ],
          );
          await db.query("COMMIT");
        } catch (error) {
          await db.query("ROLLBACK");
          throw error;
        } finally {
          db.release();
        }
      },
      dispose: () => database.dispose(),
    };
  },
  {
    skip: testDatabaseConfigured()
      ? undefined
      : "No disposable PostgreSQL test database configured",
  },
);
