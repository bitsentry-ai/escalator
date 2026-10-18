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
import { finishDeployment } from "@bitsentry-escalator/features/application";
import {
  seedDeploymentFixture,
  fixtureDeployment,
} from "@escalator-test/deployments";
import { PostgresDeploymentWatchRepository } from "../../src/platform/database/deployment-watch.repository.js";
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
async function create(withProbe = false) {
  const database = await postgresFixture(
    await readMigrations(resolve("migrations")),
  );
  const repository = new PostgresDeploymentWatchRepository(database.app);
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
  if (withProbe)
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
            intervalSeconds: 60,
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
  return { ...f, scope, entry };
}
test(
  "PostgreSQL watch initialization is scoped, durable and idempotent under concurrent callers",
  options,
  async () => {
    const f = await create();
    try {
      const initialize = () =>
        f.repository.transaction(f.scope, (tx) =>
          tx.watches.initialize(f.entry.targetId, f.entry.deployment.id),
        );
      const [first, second] = await Promise.all([initialize(), initialize()]);
      assert.deepEqual(second, first);
      assert.equal(first.revision, 1);
      const fresh = new PostgresDeploymentWatchRepository(f.database.app);
      assert.deepEqual(
        await fresh.transaction(f.scope, (tx) =>
          tx.watches.get(f.entry.targetId, f.entry.deployment.id),
        ),
        first,
      );
      await assert.rejects(
        fresh.transaction(workspaceIdSchema.parse(randomUUID()), (tx) =>
          tx.watches.get(f.entry.targetId, f.entry.deployment.id),
        ),
        /not_found/,
      );
    } finally {
      await f.dispose();
    }
  },
);
test(
  "PostgreSQL watch CAS and poisoned rollback preserve the previous record",
  options,
  async () => {
    const f = await create();
    try {
      await f.repository.transaction(f.scope, (tx) =>
        tx.watches.initialize(f.entry.targetId, f.entry.deployment.id),
      );
      await assert.rejects(
        f.repository.transaction(f.scope, async (tx) => {
          const at = await tx.currentTime();
          await tx.watches.advance(f.entry.targetId, f.entry.deployment.id, 1, {
            evaluatedAt: at,
            streams: [],
            inventoryComplete: true,
            overlappingDeploymentIds: [],
            overlapInventoryComplete: true,
          });
          await assert.rejects(
            tx.watches.advance(f.entry.targetId, f.entry.deployment.id, 0, {
              evaluatedAt: at,
              streams: [],
              inventoryComplete: true,
              overlappingDeploymentIds: [],
              overlapInventoryComplete: true,
            }),
            /revision/,
          );
        }),
        /revision/,
      );
      const saved = await f.repository.transaction(f.scope, (tx) =>
        tx.watches.get(f.entry.targetId, f.entry.deployment.id),
      );
      assert.equal(saved?.revision, 1);
      assert.equal(saved?.verdict, "PENDING");
      assert.equal(
        await f.repository.transaction(f.scope, async (tx) =>
          tx.watches.advance(f.entry.targetId, f.entry.deployment.id, 99, {
            evaluatedAt: await tx.currentTime(),
            streams: [],
            inventoryComplete: true,
            overlappingDeploymentIds: [],
            overlapInventoryComplete: true,
          }),
        ),
        undefined,
      );
    } finally {
      await f.dispose();
    }
  },
);

test(
  "PostgreSQL watch pins the captured source and RLS hides both records without scope",
  options,
  async () => {
    const f = await create(true);
    try {
      const value = await f.repository.transaction(f.scope, (tx) =>
        tx.watches.initialize(f.entry.targetId, f.entry.deployment.id),
      );
      const db = await f.database.app.connect();
      try {
        await db.query("BEGIN");
        assert.equal(
          (
            await db.query(
              "SELECT deployment_id FROM escalator_deployment_watch",
            )
          ).rowCount,
          0,
        );
        assert.equal(
          (await db.query("SELECT deployment_id FROM escalator_deployment_pin"))
            .rowCount,
          0,
        );
        await db.query("SELECT set_config('app.workspace_id',$1,true)", [
          f.scope,
        ]);
        const pins = await db.query(
          "SELECT source_id,starts_at,ends_at,expires_at FROM escalator_deployment_pin WHERE workspace_id=$1 AND deployment_id=$2 AND purpose='watch'",
          [f.scope, f.entry.deployment.id],
        );
        assert.equal(pins.rowCount, 1);
        assert.equal(pins.rows[0].source_id, "source");
        assert.equal(pins.rows[0].starts_at.toISOString(), value.startedAt);
        assert.equal(pins.rows[0].ends_at.toISOString(), value.endsAt);
        assert.equal(
          pins.rows[0].expires_at.getTime() - Date.parse(value.startedAt),
          604800000,
        );
        await db.query("ROLLBACK");
      } finally {
        db.release();
      }
    } finally {
      await f.dispose();
    }
  },
);
