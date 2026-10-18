import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  workspaceIdSchema,
  probeSchema,
  signalSourceSchema,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import {
  finishDeployment,
  WatchCadenceCoordinator,
  WatchProbeCadenceJobs,
  defaultProbeLimits,
  type CoverageRepository,
  type CoverageTransaction,
  type WatchRuntimeTransaction,
  type WatchCadenceTransaction,
  type StuckDeploymentTransaction,
  type ConfigurationRepository,
  type DurableWorkStore,
} from "@bitsentry-escalator/features/application";
import { seedDeploymentFixture, fixtureDeployment } from "./deployments.js";
type Transaction = CoverageTransaction &
  WatchRuntimeTransaction &
  WatchCadenceTransaction &
  StuckDeploymentTransaction;
interface Repository extends CoverageRepository {
  transaction<T>(
    scope: WorkspaceId,
    run: (tx: Transaction) => Promise<T>,
  ): Promise<T>;
}
interface Fixture {
  repository: Repository;
  configuration: ConfigurationRepository;
  work: DurableWorkStore;
  dispose(): Promise<void>;
}
export function watchRuntimeConformance(
  name: string,
  create: () => Promise<Fixture>,
  options: {
    skip?: string;
    register?: (name: string, run: () => Promise<void>) => unknown;
  } = {},
) {
  const register =
    options.register ??
    ((title, run) => test(title, { skip: options.skip }, run));
  function scenario(
    title: string,
    run: (f: Fixture, scope: WorkspaceId) => Promise<void>,
  ) {
    register(`${name}: ${title}`, async () => {
      const f = await create(),
        scope = workspaceIdSchema.parse(randomUUID());
      try {
        await seedDeploymentFixture(f, scope);
        await seedProbe(f, scope);
        await run(f, scope);
      } finally {
        await f.dispose();
      }
    });
  }
  async function seedProbe(f: Fixture, scope: WorkspaceId) {
    await f.repository.transaction(scope, async (tx) => {
      const p = tx.probeContext;
      await p.probes.lockCapacity();
      const binding = {
        workspaceId: scope,
        serviceId: "api",
        environmentId: "prod",
      };
      await p.sources.insert(
        signalSourceSchema.parse({
          ...binding,
          id: "source",
          name: "HTTP",
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
      await p.probes.put(
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
    });
  }
  async function start(f: Fixture, scope: WorkspaceId, id = "deploy") {
    return f.repository.transaction(scope, async (tx) => {
      const entry = await fixtureDeployment(tx, id);
      await tx.deployments.insert(entry);
      return entry;
    });
  }
  async function finish(
    f: Fixture,
    scope: WorkspaceId,
    id: string,
    rollback = false,
  ) {
    return f.repository.transaction(scope, async (tx) => {
      const entry = (await tx.deployments.get("target", id))!;
      const result = finishDeployment(
        entry.deployment,
        {
          version: 1,
          source: entry.deployment.source,
          externalId: entry.deployment.externalId,
          environmentId: entry.deployment.environmentId,
          actor: "ci",
          occurredAt: tx.now,
          outcome: "SUCCEEDED",
        },
        tx.now,
      );
      if (result.state !== "changed")
        throw new Error("Fixture finish was not accepted");
      assert.ok(
        await tx.deployments.replace(
          entry.targetId,
          result.deployment,
          entry.deployment.revision,
        ),
      );
      const watch = await tx.watches.get(entry.targetId, id);
      assert.ok(watch);
      if (rollback) throw new Error("injected finish rollback");
      return watch;
    });
  }
  scenario(
    "start and finish atomically create baseline, watch and usable cadence work",
    async (f, scope) => {
      const entry = await start(f, scope);
      const watch = await finish(f, scope, entry.deployment.id);
      await f.repository.transaction(scope, async (tx) => {
        const baseline = await tx.baselines.get(
          entry.targetId,
          entry.deployment.id,
        );
        assert.equal(baseline?.streams[0]?.id, "probe");
        assert.equal(
          await tx.coverage.get(entry.targetId, "missing-proof"),
          undefined,
        );
      });
      const batch = await f.work.claim({
        workspaceId: scope,
        queue: "job",
        kinds: ["deployment.watch-cadence"],
        token: randomUUID(),
        leaseMs: 60000,
      });
      assert.ok(batch);
      assert.equal(batch.payload.startedAt, watch.startedAt);
      assert.ok(
        await f.work.settle(
          batch,
          await new WatchCadenceCoordinator(f.repository).run(batch),
        ),
      );
      const child = await f.work.claim({
        workspaceId: scope,
        queue: "job",
        kinds: ["deployment.watch-probe-cadence"],
        token: randomUUID(),
        leaseMs: 60000,
      });
      assert.ok(child);
      assert.ok(
        await f.work.settle(
          child,
          await new WatchProbeCadenceJobs(f.repository, {
            ...defaultProbeLimits,
          }).tighten(child),
        ),
      );
      await f.repository.transaction(scope, async (tx) => {
        const receipt = await tx.cadence.receipt(
          entry.targetId,
          entry.deployment.id,
          "probe",
        );
        assert.equal(receipt?.decision, "tightened");
        assert.equal(
          (await tx.probeContext.probes.get("probe"))?.intervalSeconds,
          60,
        );
        assert.equal(
          (await tx.cadence.lease(entry.targetId, "probe"))
            ?.originalIntervalSeconds,
          300,
        );
      });
    },
  );
  scenario(
    "failed finish rolls back lifecycle, watch and job intents together",
    async (f, scope) => {
      const entry = await start(f, scope);
      await assert.rejects(
        finish(f, scope, entry.deployment.id, true),
        /injected finish rollback/,
      );
      await f.repository.transaction(scope, async (tx) => {
        assert.equal(
          (await tx.deployments.get(entry.targetId, entry.deployment.id))
            ?.deployment.status,
          "STARTED",
        );
        assert.equal(
          await tx.watches.get(entry.targetId, entry.deployment.id),
          undefined,
        );
      });
      assert.equal(
        await f.work.claim({
          workspaceId: scope,
          queue: "job",
          kinds: ["deployment.watch-cadence"],
          token: randomUUID(),
          leaseMs: 60000,
        }),
        undefined,
      );
      assert.ok(await finish(f, scope, entry.deployment.id));
    },
  );
  scenario(
    "evidence reads retain overlapping watches and reject foreign scope",
    async (f, scope) => {
      const first = await start(f, scope, "earlier");
      await finish(f, scope, first.deployment.id);
      const second = await start(f, scope, "later"),
        watch = await finish(f, scope, second.deployment.id);
      // The live runner first polls after 60s. Here only the reader is invoked; advance
      // beyond timestamp precision without starting any server or waiting a watch window.
      await new Promise((resolve) => setTimeout(resolve, 10));
      await f.repository.transaction(scope, async (tx) => {
        const entry = (await tx.deployments.get(
          second.targetId,
          second.deployment.id,
        ))!;
        const baseline = await tx.baselines.get(
          entry.targetId,
          entry.deployment.id,
        );
        const update = await tx.watchEvidence.read(entry, watch, baseline);
        assert.deepEqual(update.overlappingDeploymentIds, [
          first.deployment.id,
        ]);
        assert.equal(update.overlapInventoryComplete, true);
        assert.equal(update.streams[0]?.id, "probe");
      });
      await assert.rejects(
        f.repository.transaction(workspaceIdSchema.parse(randomUUID()), (tx) =>
          tx.watches.get(second.targetId, second.deployment.id),
        ),
        /not_found/,
      );
    },
  );
}
