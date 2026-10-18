import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { PoolClient } from "pg";
import {
  seedDeploymentFixture,
  fixtureDeployment,
} from "@escalator-test/deployments";
import { metricFixtureObservation } from "@escalator-test/metrics";
import {
  workspaceIdSchema,
  serviceIdSchema,
  environmentIdSchema,
  signalSourceSchema,
  probeSchema,
  metricMonitorSchema,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import {
  probeJobId,
  metricPointAt,
} from "@bitsentry-escalator/features/application";
import { PostgresDeploymentBaselineRepository } from "../../src/platform/database/deployment-baseline.repository.js";
import { PostgresConfigurationRepository } from "../../src/platform/database/configuration.repository.js";
import { PostgresProbeRepository } from "../../src/platform/database/probes.repository.js";
import { PostgresMetricsRepository } from "../../src/platform/database/metrics.repository.js";
import { PostgresReplayPruneRepository } from "../../src/platform/database/retention-prune.repository.js";
import { PostgresWorkStore } from "../../src/platform/jobs/postgres-work.store.js";
import { readMigrations } from "../../src/platform/database/migrate.js";
import { postgresFixture, testDatabaseConfigured } from "./postgres-fixture.js";
const options = testDatabaseConfigured()
  ? {}
  : {
      skip: "Not runtime-verified: configure both explicit disposable PostgreSQL test variables",
    };
async function create() {
  const database = await postgresFixture(
    await readMigrations(resolve("migrations")),
    { baselineMutationPrivileges: true },
  );
  const repository = new PostgresDeploymentBaselineRepository(database.app);
  const configuration = new PostgresConfigurationRepository(database.app);
  const work = new PostgresWorkStore(database.app);
  const probes = new PostgresProbeRepository(database.app);
  const metrics = new PostgresMetricsRepository(database.app);
  const f = {
    database,
    repository,
    configuration,
    work,
    probes,
    metrics,
    pruning: new PostgresReplayPruneRepository(database.app),
    dispose: () => database.dispose(),
  };
  return {
    ...f,
    async scoped<T>(
      scope: WorkspaceId,
      run: (db: PoolClient) => Promise<T>,
    ): Promise<T> {
      const connection = await database.app.connect();
      try {
        await connection.query("BEGIN");
        await connection.query(
          "SELECT set_config('app.workspace_id',$1,true)",
          [scope],
        );
        const result = await run(connection);
        await connection.query("COMMIT");
        return result;
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      } finally {
        connection.release();
      }
    },
    async seed(scope: WorkspaceId) {
      await seedDeploymentFixture(f, scope);
      const binding = {
        workspaceId: scope,
        serviceId: serviceIdSchema.parse("api"),
        environmentId: environmentIdSchema.parse("prod"),
      };
      const source = (kind: "probe" | "metrics", now: string) =>
        signalSourceSchema.parse({
          ...binding,
          id: `${kind}-source`,
          name: kind,
          kind,
          enabled: true,
          version: 1,
          grouping: "source-fingerprint",
          recovery: "explicit",
          recoveryHoldSeconds: 60,
          authSecretId: null,
          createdAt: now,
          updatedAt: now,
        });
      const receipt = await probes.transaction(scope, async (tx) => {
        await tx.sources.insert(source("probe", tx.now));
        const probe = probeSchema.parse({
          ...binding,
          id: "probe",
          sourceId: "probe-source",
          name: "HTTP",
          version: 1,
          enabled: true,
          intervalSeconds: 60,
          critical: true,
          failureThreshold: 1,
          recoveryThreshold: 1,
          config: {
            url: "https://example.test/health",
            method: "GET",
            body: null,
            authSecretId: null,
            timeoutMs: 1000,
            maxResponseBytes: 1000,
            assertions: { status: [200], contains: null, json: [] },
            syntheticWrite: null,
          },
          createdAt: tx.now,
          updatedAt: tx.now,
        });
        await tx.probes.put(probe, null);
        const id = probeJobId(scope, probe.id, 1, tx.now);
        await tx.work.enqueue("job", {
          id,
          kind: "probe.execute",
          idempotencyKey: id,
          dueAt: tx.now,
          payload: {
            probeId: probe.id,
            probeVersion: 1,
            dueAt: tx.now,
            secretIds: [],
          },
        });
        await tx.probes.recordResult({
          id,
          workspaceId: scope,
          probeId: probe.id,
          probeVersion: 1,
          observedAt: tx.now,
          outcome: "healthy",
          reason: "assertions_passed",
          statusCode: 200,
          durationMs: 1,
        });
        return id;
      });
      const lease = await work.claim({
        workspaceId: scope,
        queue: "job",
        token: randomUUID(),
        leaseMs: 60000,
        kinds: ["probe.execute"],
      });
      assert.ok(lease);
      assert.equal(await work.settle(lease, { state: "completed" }), true);
      await metrics.transaction(scope, async (tx) => {
        await tx.sources.insert(source("metrics", tx.now));
        const monitor = metricMonitorSchema.parse({
          ...binding,
          id: "metric",
          sourceId: "metrics-source",
          name: "Requests",
          enabled: true,
          version: 1,
          stepSeconds: 60,
          createdAt: tx.now,
          updatedAt: tx.now,
          query: {
            connection: {
              provider: "prometheus",
              baseUrl: "https://metrics.example",
              authSecretId: null,
            },
            requestsQuery: "sum(increase(requests[60s]))",
            errorsQuery: "sum(increase(errors[60s]))",
          },
          rule: {
            windowSeconds: 120,
            minimumSamples: 2,
            minimumRequests: 100,
            errorRateFloor: 0.05,
          },
        });
        await tx.metrics.put(monitor, null);
        await tx.metrics.observe(
          metricFixtureObservation(
            tx,
            monitor,
            "metric-receipt",
            metricPointAt(tx.now, 60),
            2,
          ),
        );
      });
      // Separate the next accepted start from receipt timestamps after millisecond normalization.
      await database.app.query("SELECT pg_sleep(0.002)");
      return receipt;
    },
  };
}
const a = workspaceIdSchema.parse("baseline_pg_a"),
  b = workspaceIdSchema.parse("baseline_pg_b");
test(
  "PostgreSQL captures actual scoped evidence without persisting measurement definitions",
  options,
  async () => {
    const f = await create();
    try {
      await f.seed(a);
      await f.repository.transaction(a, async (tx) =>
        tx.deployments.insert(await fixtureDeployment(tx)),
      );
      const baseline = (await f.repository.transaction(a, (tx) =>
        tx.baselines.get("target", "deployment"),
      ))!;
      assert.equal(baseline.inventoryComplete, true);
      assert.equal(baseline.streams.length, 2);
      assert.equal(
        baseline.streams.find((row) => row.kind === "probe")!.evidence
          .samples[0].reading.kind,
        "probe",
      );
      assert.deepEqual(
        baseline.streams.find((row) => row.kind === "metric")!.evidence
          .samples[0].reading,
        { kind: "metric", quality: "complete", requests: 100, errors: 2 },
      );
      const raw = await f.scoped(a, (db) =>
        db.query("SELECT data FROM escalator_deployment_baseline"),
      );
      assert.equal(JSON.stringify(raw.rows[0].data).includes("example"), false);
      assert.equal(
        JSON.stringify(raw.rows[0].data).includes("workspaceId"),
        false,
      );
      await assert.rejects(
        f.repository.transaction(a, async (tx) =>
          tx.deployments.insert(await fixtureDeployment(tx)),
        ),
      );
      assert.deepEqual(
        await f.repository.transaction(a, (tx) =>
          tx.baselines.get("target", "deployment"),
        ),
        baseline,
      );
    } finally {
      await f.dispose();
    }
  },
);
test(
  "PostgreSQL baseline and pin policies isolate populated tenants and forbid active mutation",
  options,
  async () => {
    const f = await create();
    try {
      for (const scope of [a, b]) {
        await f.seed(scope);
        await f.repository.transaction(scope, async (tx) =>
          tx.deployments.insert(await fixtureDeployment(tx)),
        );
      }
      for (const table of [
        "escalator_deployment_baseline",
        "escalator_deployment_pin",
      ])
        assert.equal(
          (await f.database.app.query(`SELECT workspace_id FROM ${table}`))
            .rowCount,
          0,
        );
      await f.scoped(a, async (db) => {
        assert.deepEqual(
          (
            await db.query(
              "SELECT DISTINCT workspace_id FROM escalator_deployment_pin",
            )
          ).rows,
          [{ workspace_id: a }],
        );
        assert.equal(
          (await db.query("UPDATE escalator_deployment_baseline SET data=data"))
            .rowCount,
          0,
        );
        assert.equal(
          (await db.query("DELETE FROM escalator_deployment_baseline"))
            .rowCount,
          0,
        );
        assert.equal(
          (
            await db.query(
              "UPDATE escalator_deployment_pin SET expires_at=expires_at",
            )
          ).rowCount,
          0,
        );
        assert.equal(
          (await db.query("DELETE FROM escalator_deployment_pin")).rowCount,
          0,
        );
      });
      await assert.rejects(
        f.scoped(a, (db) =>
          db.query(
            `INSERT INTO escalator_deployment_baseline
      SELECT $1,deployment_id,target_id,service_id,environment_id,started_at,captured_at,data
      FROM escalator_deployment_baseline`,
            [b],
          ),
        ),
        { code: "42501" },
      );
      assert.equal(
        (await f.repository.transaction(b, (tx) =>
          tx.baselines.get("target", "deployment"),
        ))!.workspaceId,
        b,
      );
    } finally {
      await f.dispose();
    }
  },
);
test(
  "PostgreSQL baseline pins protect completed receipts from retention eligibility",
  options,
  async () => {
    const f = await create();
    try {
      const receipt = await f.seed(a);
      const snapshot = () =>
        f.pruning.transaction(a, "probe-source", (tx) =>
          tx.retentionPrune.snapshot(null),
        );
      assert.equal(
        (await snapshot()).candidates.find((row) => row.id === receipt)!
          .protected,
        false,
      );
      await f.repository.transaction(a, async (tx) =>
        tx.deployments.insert(await fixtureDeployment(tx)),
      );
      assert.equal(
        (await snapshot()).candidates.find((row) => row.id === receipt)!
          .protected,
        true,
      );
    } finally {
      await f.dispose();
    }
  },
);
test(
  "PostgreSQL caller rollback removes deployment, baseline and pins together",
  options,
  async () => {
    const f = await create();
    try {
      await f.seed(a);
      await assert.rejects(
        f.repository.transaction(a, async (tx) => {
          await tx.deployments.insert(await fixtureDeployment(tx));
          throw new Error("abort");
        }),
        /abort/,
      );
      await f.scoped(a, async (db) => {
        for (const table of [
          "escalator_deployment",
          "escalator_deployment_baseline",
          "escalator_deployment_pin",
        ])
          assert.equal(
            (await db.query(`SELECT workspace_id FROM ${table}`)).rowCount,
            0,
          );
      });
    } finally {
      await f.dispose();
    }
  },
);
