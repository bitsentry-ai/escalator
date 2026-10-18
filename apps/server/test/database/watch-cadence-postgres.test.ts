import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  workspaceIdSchema,
  signalSourceSchema,
  probeSchema,
  serviceIdSchema,
  environmentIdSchema,
} from "@bitsentry-escalator/features/contracts";
import {
  WatchCadenceCoordinator,
  WatchProbeCadenceJobs,
  defaultProbeLimits,
  pagingWorkId,
  finishDeployment,
} from "@bitsentry-escalator/features/application";
import {
  seedDeploymentFixture,
  fixtureDeployment,
} from "@escalator-test/deployments";
import { PostgresWatchCadenceRepository } from "../../src/platform/database/watch-cadence.repository.js";
import { PostgresConfigurationRepository } from "../../src/platform/database/configuration.repository.js";
import { PostgresWorkStore } from "../../src/platform/jobs/postgres-work.store.js";
import { readMigrations } from "../../src/platform/database/migrate.js";
import { postgresFixture, testDatabaseConfigured } from "./postgres-fixture.js";
import { PostgresProbeRepository } from "../../src/platform/database/probes.repository.js";
const options = testDatabaseConfigured()
  ? {}
  : {
      skip: "Not runtime-verified: configure both explicit disposable PostgreSQL test variables",
    };
async function create() {
  const database = await postgresFixture(
    await readMigrations(resolve("migrations")),
  );
  const repository = new PostgresWatchCadenceRepository(database.app);
  const configuration = new PostgresConfigurationRepository(database.app);
  const work = new PostgresWorkStore(database.app);
  const f = {
    database,
    repository,
    configuration,
    work,
    dispose: () => database.dispose(),
  };
  const scope = workspaceIdSchema.parse(randomUUID());
  await seedDeploymentFixture(f, scope);
  await new PostgresProbeRepository(database.app).transaction(
    scope,
    async (tx) => {
      const binding = {
        workspaceId: scope,
        serviceId: serviceIdSchema.parse("api"),
        environmentId: environmentIdSchema.parse("prod"),
      };
      await tx.sources.insert(
        signalSourceSchema.parse({
          ...binding,
          id: "source",
          name: "Probe",
          kind: "probe",
          enabled: true,
          version: 1,
          grouping: "source-fingerprint",
          recovery: "explicit",
          recoveryHoldSeconds: 60,
          authSecretId: null,
          createdAt: tx.now,
          updatedAt: tx.now,
        }),
      );
      await tx.probes.put(
        probeSchema.parse({
          ...binding,
          id: "probe",
          sourceId: "source",
          name: "HTTP",
          version: 1,
          enabled: true,
          intervalSeconds: 300,
          critical: true,
          failureThreshold: 1,
          recoveryThreshold: 1,
          createdAt: tx.now,
          updatedAt: tx.now,
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
        }),
        null,
      );
    },
  );
  const entry = await repository.transaction(scope, async (tx) => {
    const value = await fixtureDeployment(tx);
    await tx.deployments.insert(value);
    const at = await tx.currentTime();
    const change = finishDeployment(
      value.deployment,
      {
        version: 1,
        source: value.deployment.source,
        externalId: value.deployment.externalId,
        environmentId: value.deployment.environmentId,
        actor: "ci",
        occurredAt: at,
        outcome: "SUCCEEDED",
      },
      at,
    );
    if (change.state !== "changed") throw new Error("Fixture finish rejected");
    assert.equal(
      await tx.deployments.replace(value.targetId, change.deployment, 1),
      true,
    );
    return value;
  });
  await repository.transaction(scope, (tx) =>
    tx.watches.initialize(entry.targetId, entry.deployment.id),
  );
  return { ...f, scope, entry };
}
type Fixture = Awaited<ReturnType<typeof create>>;
async function ready(f: Fixture) {
  await f.repository.transaction(f.scope, async (tx) => {
    const watch = (await tx.watches.get(
      f.entry.targetId,
      f.entry.deployment.id,
    ))!;
    const id = pagingWorkId(
      f.scope,
      "deployment.watch-cadence",
      watch.targetId,
      watch.deploymentId,
    );
    await tx.work.enqueue("job", {
      id,
      kind: "deployment.watch-cadence",
      idempotencyKey: id,
      dueAt: tx.now,
      priority: 80,
      payload: {
        targetId: watch.targetId,
        deploymentId: watch.deploymentId,
        startedAt: watch.startedAt,
      },
    });
  });
  const batch = await f.work.claim({
    workspaceId: f.scope,
    queue: "job",
    kinds: ["deployment.watch-cadence"],
    token: randomUUID(),
    leaseMs: 60000,
  });
  assert.ok(batch);
  assert.ok(
    await f.work.settle(
      batch,
      await new WatchCadenceCoordinator(f.repository).run(batch),
    ),
  );
  const child = await f.work.claim({
    workspaceId: f.scope,
    queue: "job",
    kinds: ["deployment.watch-probe-cadence"],
    token: randomUUID(),
    leaseMs: 60000,
  });
  assert.ok(child);
  return child;
}
test(
  "PostgreSQL cadence serializes duplicate applications and survives adapter reconstruction",
  options,
  async () => {
    const f = await create();
    try {
      const lease = await ready(f),
        jobs = new WatchProbeCadenceJobs(f.repository, {
          ...defaultProbeLimits,
        });
      await Promise.all([jobs.tighten(lease), jobs.tighten(lease)]);
      const fresh = new PostgresWatchCadenceRepository(f.database.app);
      await fresh.transaction(f.scope, async (tx) => {
        const receipt = await tx.cadence.receipt(
          f.entry.targetId,
          f.entry.deployment.id,
          "probe",
        );
        const owner = await tx.cadence.lease(f.entry.targetId, "probe");
        const probe = await tx.probeContext.probes.get("probe");
        assert.equal(receipt?.decision, "tightened");
        assert.equal(receipt?.appliedProbeVersion, 2);
        assert.equal(owner?.originalIntervalSeconds, 300);
        assert.equal(probe?.intervalSeconds, 60);
        assert.equal(probe?.version, 2);
        assert.equal(
          (await tx.probeContext.probes.schedule("probe"))?.probeVersion,
          2,
        );
      });
      await assert.rejects(
        fresh.transaction(workspaceIdSchema.parse(randomUUID()), (tx) =>
          tx.cadence.lease(f.entry.targetId, "probe"),
        ),
        /not_found/,
      );
    } finally {
      await f.dispose();
    }
  },
);
test(
  "PostgreSQL cadence callback failure rolls back probe and restoration intent",
  options,
  async () => {
    const f = await create();
    try {
      const lease = await ready(f);
      const failing: import("@bitsentry-escalator/features/application").WatchCadenceRepository =
        {
          transaction: (scope, run) =>
            f.repository.transaction(scope, async (tx) => {
              await run(tx);
              throw new Error("injected commit failure");
            }),
        };
      await assert.rejects(
        new WatchProbeCadenceJobs(failing, { ...defaultProbeLimits }).tighten(
          lease,
        ),
        /injected commit failure/,
      );
      await f.repository.transaction(f.scope, async (tx) => {
        assert.equal((await tx.probeContext.probes.get("probe"))?.version, 1);
        assert.equal(
          await tx.cadence.lease(f.entry.targetId, "probe"),
          undefined,
        );
        assert.equal(
          await tx.cadence.receipt(
            f.entry.targetId,
            f.entry.deployment.id,
            "probe",
          ),
          undefined,
        );
        assert.equal(await tx.probeContext.probes.schedule("probe"), undefined);
      });
      const db = await f.database.app.connect();
      try {
        await db.query("BEGIN");
        await db.query("SELECT set_config('app.workspace_id',$1,true)", [
          f.scope,
        ]);
        assert.equal(
          (
            await db.query(
              "SELECT id FROM escalator_job WHERE workspace_id=$1 AND kind='deployment.watch-cadence-restore'",
              [f.scope],
            )
          ).rowCount,
          0,
        );
      } finally {
        await db.query("ROLLBACK");
        db.release();
      }
      await new WatchProbeCadenceJobs(f.repository, {
        ...defaultProbeLimits,
      }).tighten(lease);
      assert.equal(
        (
          await f.repository.transaction(f.scope, (tx) =>
            tx.probeContext.probes.get("probe"),
          )
        )?.version,
        2,
      );
    } finally {
      await f.dispose();
    }
  },
);
test(
  "PostgreSQL cadence RLS hides other scopes and receipts cannot be mutated",
  options,
  async () => {
    const f = await create();
    try {
      await new WatchProbeCadenceJobs(f.repository, {
        ...defaultProbeLimits,
      }).tighten(await ready(f));
      const db = await f.database.app.connect();
      try {
        await db.query("BEGIN");
        await db.query("SELECT set_config('app.workspace_id',$1,true)", [
          randomUUID(),
        ]);
        assert.equal(
          (await db.query("SELECT probe_id FROM escalator_watch_cadence_lease"))
            .rowCount,
          0,
        );
        assert.equal(
          (
            await db.query(
              "SELECT probe_id FROM escalator_watch_cadence_receipt",
            )
          ).rowCount,
          0,
        );
        await db.query("SELECT set_config('app.workspace_id',$1,true)", [
          f.scope,
        ]);
        assert.equal(
          (
            await db.query(
              "SELECT probe_id FROM escalator_watch_cadence_receipt",
            )
          ).rowCount,
          1,
        );
        await assert.rejects(
          db.query(
            "DELETE FROM escalator_watch_cadence_receipt WHERE workspace_id=$1",
            [f.scope],
          ),
          /permission denied/,
        );
      } finally {
        await db.query("ROLLBACK");
        db.release();
      }
    } finally {
      await f.dispose();
    }
  },
);
