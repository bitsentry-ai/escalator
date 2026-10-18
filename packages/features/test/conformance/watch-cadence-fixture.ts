import assert from "node:assert/strict";
import {
  workspaceIdSchema,
  probeSchema,
  signalSourceSchema,
  type WatchCadenceReceipt,
} from "../../src/contracts/index.js";
import { planWatchCadence } from "../../src/application/deploy/cadence.js";
import { finishDeployment } from "../../src/domain/deploy/lifecycle.js";
import { baselineFromProjection } from "../../src/application/deploy/baseline-reader.js";
import { seedDeploymentFixture, fixtureDeployment } from "./deployments.js";
import { MemoryWatchCadenceRepository } from "./memory-watch-cadence.js";
export const scope = workspaceIdSchema.parse("cadence-storage");
export const at = (s: number) =>
  new Date(Date.parse("2026-10-05T00:00:00Z") + s * 1000).toISOString();
export async function fixture() {
  let seconds = 0;
  const repo = new MemoryWatchCadenceRepository({
    now: () => new Date(at(seconds)),
  });
  await seedDeploymentFixture(
    {
      repository: repo,
      configuration: repo.configuration,
      work: repo.work,
      dispose: async () => {},
    },
    scope,
  );
  await repo.transaction(scope, async (tx) => {
    await tx.probeContext.probes.lockCapacity();
    await tx.probeContext.sources.insert(
      signalSourceSchema.parse({
        id: "probe-source",
        workspaceId: scope,
        serviceId: "api",
        environmentId: "prod",
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
    await tx.probeContext.probes.put(
      probeSchema.parse({
        id: "probe",
        sourceId: "probe-source",
        workspaceId: scope,
        serviceId: "api",
        environmentId: "prod",
        name: "Probe",
        version: 1,
        enabled: true,
        intervalSeconds: 300,
        critical: true,
        failureThreshold: 1,
        recoveryThreshold: 2,
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
      }),
      null,
    );
  });
  repo.watches.captureBaseline = (entry) =>
    baselineFromProjection(entry, {
      workspaceId: scope,
      serviceId: entry.deployment.serviceId,
      environmentId: entry.deployment.environmentId,
      capturedAt: at(seconds),
      inventoryComplete: true,
      streams: [
        {
          workspaceId: scope,
          serviceId: entry.deployment.serviceId,
          environmentId: entry.deployment.environmentId,
          kind: "probe",
          id: "probe",
          sourceId: "probe-source",
          configurationVersion: 1,
          measurementHash: "a".repeat(64),
          complete: false,
          critical: true,
          failureThreshold: 1,
          configurations: [],
          receipts: [],
        },
      ],
    });
  const entry = await repo.transaction(scope, async (tx) => {
    const entry = await fixtureDeployment(tx);
    await tx.deployments.insert(entry);
    const change = finishDeployment(
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
    if (change.state !== "changed") throw new Error();
    await tx.deployments.replace(entry.targetId, change.deployment, 1);
    await tx.watches.initialize(entry.targetId, entry.deployment.id);
    return entry;
  });
  async function apply(catchFailure = false) {
    return repo.transaction(scope, async (tx) => {
      const prior = await tx.cadence.receipt(
        entry.targetId,
        entry.deployment.id,
        "probe",
      );
      if (prior) return prior;
      const watch = (await tx.watches.get(
        entry.targetId,
        entry.deployment.id,
      ))!;
      const baseline = (await tx.baselines.get(
        entry.targetId,
        entry.deployment.id,
      ))!;
      const probe = (await tx.probeContext.probes.lock("probe"))!;
      const plan = planWatchCadence(
        watch,
        baseline.streams[0],
        probe,
        undefined,
        tx.now,
      );
      if (plan.state !== "tighten") throw new Error("Expected tightening plan");
      assert.ok(await tx.probeContext.probes.put(plan.probe, probe.version));
      assert.ok(
        await tx.cadence.putLease(entry.deployment.id, plan.lease, null),
      );
      const receipt: WatchCadenceReceipt = {
        workspaceId: scope,
        targetId: entry.targetId,
        deploymentId: entry.deployment.id,
        probeId: probe.id,
        sourceId: probe.sourceId,
        serviceId: probe.serviceId,
        environmentId: probe.environmentId,
        recordedAt: tx.now,
        decision: "tightened",
        generationId: plan.lease.generationId,
        appliedProbeVersion: plan.probe.version,
      };
      try {
        await tx.cadence.record(receipt);
      } catch (error) {
        if (!catchFailure) throw error;
      }
      return receipt;
    });
  }
  return {
    repo,
    entry,
    apply,
    time: (s: number) => {
      seconds = s;
    },
  };
}
