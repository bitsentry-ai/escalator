import {
  signalSourceSchema,
  signalEventSchema,
} from "../src/contracts/index.js";
import { watchIncidentCorrelation } from "../src/application/deploy/watch-correlation.js";
import { watchPagePolicy } from "../src/application/deploy/watch-page-policy.js";
import { TransactionGuard } from "../src/application/ports/transaction-guard.js";
import { openPageInTransaction } from "../src/application/paging/create-page.js";
import { SignalProcessing } from "../src/application/detection/process.js";
import { alertIdentity } from "../src/domain/alerts/transition.js";
import { MemoryDetectionRepository } from "./conformance/memory-detection.js";
import { seedPagingFixture } from "./conformance/paging.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  workspaceIdSchema,
  type DeploymentEntry,
  type DeploymentWatchRecord,
  type DeploymentBaseline,
  type WorkspaceId,
} from "../src/contracts/index.js";
import {
  finishDeployment,
  timeoutDeployment,
} from "../src/domain/deploy/lifecycle.js";
import { baselineFromProjection } from "../src/application/deploy/baseline-reader.js";
import { evaluateWatchProjection } from "../src/application/deploy/watch-reader.js";
import { withDeploymentWatchJobs } from "../src/application/deploy/watch-finish.js";
import {
  DeploymentWatches,
  withDeploymentWatchHandlers,
  type WatchRuntimeTransaction,
} from "../src/application/deploy/watch-runtime.js";
import { pagingWorkId } from "../src/application/paging/work-ids.js";
import { MemoryDeploymentWatchRepository } from "./conformance/memory-deployment-watches.js";
import {
  seedDeploymentFixture,
  fixtureDeployment,
} from "./conformance/deployments.js";
const scope = workspaceIdSchema.parse("watch-runtime");
const at = (seconds: number) =>
  new Date(Date.parse("2026-10-04T00:00:00Z") + seconds * 1000).toISOString();
function projection(
  entry: DeploymentEntry,
  seconds: number,
  baseline: boolean,
  failed: boolean,
) {
  const start = baseline ? -900 : 0;
  return {
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
        sourceId: "source",
        configurationVersion: 1,
        measurementHash: "a".repeat(64),
        complete: true,
        critical: true,
        failureThreshold: 1,
        configurations: [
          {
            version: 1,
            effectiveAt: at(-3600),
            recordedAt: at(-3600),
            enabled: true,
            anchorAt: at(0),
            stepSeconds: 60,
            measurementHash: "a".repeat(64),
          },
        ],
        receipts: Array.from(
          {
            length: baseline
              ? 15
              : Math.max(1, Math.min(30, Math.floor(seconds / 60))),
          },
          (_, i) => ({
            id: `${baseline ? "base" : "watch"}-${i}`,
            version: 1,
            slotAt: at(start + i * 60),
            observedAt: at(start + i * 60 + 1),
            receivedAt: at(start + i * 60 + 2),
            usable: true,
            reading: { kind: "probe", state: failed ? "failed" : "healthy" },
          }),
        ),
      },
    ],
  };
}
async function fixture(options: { baseline?: boolean; failed?: boolean } = {}) {
  let seconds = 0;
  const storage = new MemoryDeploymentWatchRepository({
    now: () => new Date(at(seconds)),
  });
  if (options.baseline)
    storage.captureBaseline = (entry) =>
      baselineFromProjection(entry, projection(entry, 0, true, false));
  const state = {
    relatedIncidentId: null as string | null,
    readFails: false,
    enqueueFails: false,
    auditFails: false,
    failed: options.failed ?? false,
  };
  const repository = {
    findTokenContext: (hash: string) => storage.findTokenContext(hash),
    transaction<T>(
      id: WorkspaceId,
      run: (tx: WatchRuntimeTransaction) => Promise<T>,
    ): Promise<T> {
      return storage.withExtensions(id, (tx, guard) => {
        const work = {
          ...tx.work,
          enqueue: async (...args: Parameters<typeof tx.work.enqueue>) => {
            const result = await tx.work.enqueue(...args);
            if (
              state.enqueueFails &&
              args[1].kind === "deployment.watch-cadence"
            )
              throw new Error("Injected enqueue failure");
            return result;
          },
        };
        return run(
          withDeploymentWatchJobs(
            {
              ...tx,
              work,
              audit: {
                ...tx.audit,
                append: async (
                  event: Parameters<typeof tx.audit.append>[0],
                ) => {
                  await tx.audit.append(event);
                  if (
                    state.auditFails &&
                    event.action === "deployment.watch_evaluated"
                  )
                    throw new Error("Injected audit failure");
                },
              },
              watchIncidents: {
                lock: async () => ({
                  incidentId: state.relatedIncidentId,
                  attach: async () => {},
                }),
              },
              watchEvidence: {
                read: async (
                  entry: DeploymentEntry,
                  watch: DeploymentWatchRecord,
                  baseline: DeploymentBaseline | undefined,
                ) => {
                  if (state.readFails)
                    throw new Error("Injected evidence failure");
                  return {
                    ...evaluateWatchProjection(
                      entry,
                      watch,
                      baseline,
                      projection(entry, seconds, false, state.failed),
                    ),
                    overlappingDeploymentIds: ["other-deploy"],
                    overlapInventoryComplete: true,
                  };
                },
              },
            },
            guard,
          ),
        );
      });
    },
  };
  await seedDeploymentFixture(
    {
      repository,
      configuration: storage.configuration,
      work: storage.work,
      dispose: async () => {},
    },
    scope,
  );
  const entry = await repository.transaction(scope, async (tx) => {
    const value = await fixtureDeployment(tx);
    await tx.deployments.insert(value);
    return value;
  });
  async function finish(
    outcome: "SUCCEEDED" | "FAILED" | "CANCELLED" = "SUCCEEDED",
    caught = false,
  ) {
    return repository.transaction(scope, async (tx) => {
      const current = (await tx.deployments.get(
        entry.targetId,
        entry.deployment.id,
      ))!.deployment;
      const change = finishDeployment(
        current,
        {
          version: 1,
          source: current.source,
          externalId: current.externalId,
          environmentId: current.environmentId,
          actor: "ci",
          occurredAt: at(seconds),
          outcome,
        },
        at(seconds),
      );
      if (change.state !== "changed")
        throw new Error("Expected finish transition");
      try {
        return await tx.deployments.replace(
          entry.targetId,
          change.deployment,
          current.revision,
        );
      } catch (error) {
        if (!caught) throw error;
        return false;
      }
    });
  }
  const get = () =>
    repository.transaction(scope, (tx) =>
      tx.watches.get(entry.targetId, entry.deployment.id),
    );
  const claim = (kind = "deployment.watch", leaseMs = 60000) =>
    storage.work.claim({
      workspaceId: scope,
      queue: "job",
      kinds: [kind],
      token: randomUUID(),
      leaseMs,
    });
  return {
    storage,
    repository,
    state,
    entry,
    finish,
    get,
    claim,
    time: (value: number) => {
      seconds = value;
    },
    runner: () => new DeploymentWatches(repository),
  };
}
test("accepted finishes atomically enqueue separate cadence and delayed watch jobs", async () => {
  for (const outcome of ["SUCCEEDED", "FAILED", "CANCELLED"] as const) {
    const f = await fixture();
    await f.finish(outcome);
    assert.equal((await f.get())?.verdict, "PENDING");
    assert.ok(await f.claim("deployment.watch-cadence"));
    assert.equal(await f.claim(), undefined);
    f.time(60);
    assert.equal((await f.claim())?.dueAt, at(60));
  }
});
test("caught enqueue failure rolls back finish, watch and both job intents", async () => {
  const f = await fixture();
  f.state.enqueueFails = true;
  await assert.rejects(f.finish("SUCCEEDED", true), /Injected enqueue/);
  const current = await f.repository.transaction(scope, (tx) =>
    tx.deployments.get(f.entry.targetId, f.entry.deployment.id),
  );
  assert.equal(current?.deployment.finish, null);
  assert.equal(await f.get(), undefined);
  f.time(60);
  assert.equal(await f.claim(), undefined);
  assert.equal(await f.claim("deployment.watch-cadence"), undefined);
});
test("watch insertion failure rolls back an accepted lifecycle finish", async () => {
  const f = await fixture();
  f.storage.failWatchInsert = true;
  await assert.rejects(f.finish(), /Injected watch/);
  assert.equal(await f.get(), undefined);
  f.time(60);
  assert.equal(await f.claim(), undefined);
});
test("empty baseline finalizes honestly and completion replay does not mutate state", async () => {
  const f = await fixture();
  await f.finish();
  f.time(1920);
  const lease = (await f.claim())!;
  assert.deepEqual(await f.runner().run(lease), { state: "completed" });
  const value = await f.get();
  assert.equal(value?.verdict, "INSUFFICIENT_DATA");
  assert.equal(value?.finalizedAt, at(1920));
  assert.equal(value?.incidentId, null);
  await f.runner().run(lease);
  assert.deepEqual(await f.get(), value);
});
test("healthy early watch waits, then finalizes after the receipt grace", async () => {
  const f = await fixture({ baseline: true });
  await f.finish();
  f.time(60);
  const lease = (await f.claim())!;
  const result = await f.runner().run(lease);
  assert.deepEqual(result, { state: "wait", delayMs: 60000 });
  assert.equal((await f.get())?.verdict, "PENDING");
  assert.ok(await f.storage.work.settle(lease, result));
  f.time(1920);
  const next = (await f.claim())!;
  assert.deepEqual(await f.runner().run(next), { state: "completed" });
  const watch = await f.get();
  assert.equal(watch?.verdict, "PASS");
  assert.deepEqual(watch?.overlappingDeploymentIds, ["other-deploy"]);
  assert.equal(watch?.incidentId, null);
});
test("failed watch opens one incident and retries retain its first evidence", async () => {
  const f = await fixture({ baseline: true, failed: true });
  await f.finish();
  f.time(60);
  const lease = (await f.claim())!;
  const firstResult = await f.runner().run(lease),
    first = (await f.get())!;
  assert.equal(first.verdict, "FAIL");
  assert.ok(first.incidentId);
  await f.runner().run(lease);
  assert.equal((await f.get())?.incidentId, first.incidentId);
  assert.ok(await f.storage.work.settle(lease, firstResult));
  f.state.failed = false;
  f.time(1920);
  await f.runner().run((await f.claim())!);
  const final = (await f.get())!;
  assert.equal(final.verdict, "FAIL");
  assert.equal(final.incidentId, first.incidentId);
  assert.deepEqual(final.firstFailure, first.firstFailure);
  const incidents = await f.repository.transaction(scope, (tx) =>
    tx.incidents.list({ limit: 100 }),
  );
  assert.equal(
    incidents.items.filter((row) => row.id === first.incidentId).length,
    1,
  );
});
test("expired watch lease cannot persist evidence or a failure page", async () => {
  const f = await fixture({ baseline: true, failed: true });
  await f.finish();
  f.time(60);
  const lease = (await f.claim("deployment.watch", 1000))!;
  f.time(62);
  assert.deepEqual(await f.runner().run(lease), { state: "completed" });
  assert.equal((await f.get())?.revision, 1);
  assert.equal((await f.get())?.incidentId, null);
});
test("an authoritative non-watch claim cannot drive watch effects", async () => {
  const f = await fixture();
  await f.finish();
  f.time(60);
  const lease = (await f.claim("deployment.watch-cadence"))!;
  await assert.rejects(
    f.runner().run({ ...lease, kind: "deployment.watch" }),
    /Invalid deployment watch claim/,
  );
  assert.equal((await f.get())?.revision, 1);
});
test("audit failure rolls back the page and verdict, allowing one clean retry", async () => {
  const f = await fixture({ baseline: true, failed: true });
  await f.finish();
  f.time(60);
  const lease = (await f.claim())!;
  f.state.auditFails = true;
  await assert.rejects(f.runner().run(lease), /Injected audit/);
  assert.equal((await f.get())?.incidentId, null);
  const id = pagingWorkId(
    scope,
    "deployment-watch-incident",
    f.entry.deployment.id,
  );
  assert.equal(
    await f.repository.transaction(scope, (tx) => tx.incidents.get(id)),
    undefined,
  );
  f.state.auditFails = false;
  await f.runner().run(lease);
  assert.equal((await f.get())?.incidentId, id);
});
test("evidence failure leaves the prior watch untouched", async () => {
  const f = await fixture();
  await f.finish();
  f.time(60);
  f.state.readFails = true;
  await assert.rejects(f.runner().run((await f.claim())!), /Injected evidence/);
  assert.equal((await f.get())?.revision, 1);
});
test("timeout alone has no watch, but a late finish starts one", async () => {
  const f = await fixture();
  f.time(3600);
  await f.repository.transaction(scope, async (tx) => {
    const change = timeoutDeployment(f.entry.deployment, at(3600));
    assert.equal(change.state, "changed");
    if (change.state === "changed")
      await tx.deployments.replace(f.entry.targetId, change.deployment, 1);
  });
  assert.equal(await f.get(), undefined);
  assert.equal(await f.claim(), undefined);
  await f.finish();
  assert.equal((await f.get())?.startedAt, at(3600));
});
test("watch handler registration preserves existing lanes and rejects duplicates", async () => {
  const f = await fixture();
  const handlers = { job: new Map(), outbox: new Map() };
  const next = withDeploymentWatchHandlers(handlers, f.repository);
  assert.equal(handlers.job.size, 0);
  assert.equal(next.job.size, 1);
  assert.equal(next.outbox, handlers.outbox);
  assert.throws(
    () => withDeploymentWatchHandlers(next, f.repository),
    /already registered/,
  );
});

test("watch links an existing detector incident without opening another page", async () => {
  const f = await fixture({ baseline: true, failed: true });
  await f.finish();
  f.time(60);
  const existingId = "existing-detector-incident";
  await f.repository.transaction(scope, (tx) =>
    openPageInTransaction(tx, {
      incident: {
        id: existingId,
        serviceId: f.entry.deployment.serviceId,
        environmentId: f.entry.deployment.environmentId,
        title: "Probe failed",
        severity: "critical",
      },
      policy: f.entry.policy,
    }),
  );
  f.state.relatedIncidentId = existingId;
  await f.runner().run((await f.claim())!);
  assert.equal((await f.get())?.incidentId, existingId);
  assert.equal(
    await f.repository.transaction(scope, (tx) =>
      tx.incidents.get(
        pagingWorkId(scope, "deployment-watch-incident", f.entry.deployment.id),
      ),
    ),
    undefined,
  );
});

test("watch group reservation coalesces later ordinary detection and keeps its watermark", async () => {
  const f = await fixture({ baseline: true, failed: true });
  await f.finish();
  f.time(60);
  await f.runner().run((await f.claim())!);
  const watch = (await f.get())!;
  const finishedEntry = (await f.repository.transaction(scope, (tx) =>
    tx.deployments.get(f.entry.targetId, f.entry.deployment.id),
  ))!;
  const detection = new MemoryDetectionRepository(() => new Date(at(60)));
  const event = signalEventSchema.parse({
    id: "normal-probe-signal",
    eventId: "normal-probe-signal",
    version: 1,
    workspaceId: scope,
    serviceId: watch.serviceId,
    environmentId: watch.environmentId,
    sourceId: "source",
    observedAt: at(59),
    receivedAt: at(60),
    status: "active",
    severity: "high",
    fingerprint: "probe:probe",
    title: "Probe failed",
    evidence: { summary: "Probe failed", attributes: [] },
  });
  await detection.transaction(scope, async (tx) => {
    await seedPagingFixture(tx);
    await tx.sources.insert(
      signalSourceSchema.parse({
        id: "source",
        workspaceId: scope,
        serviceId: watch.serviceId,
        environmentId: watch.environmentId,
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
    const guard = new TransactionGuard();
    const binding = await watchIncidentCorrelation(tx, guard).lock(watch);
    assert.equal(binding.incidentId, null);
    await openPageInTransaction(tx, {
      incident: {
        id: watch.incidentId!,
        serviceId: watch.serviceId,
        environmentId: watch.environmentId,
        title: "Post-deployment health watch failed",
        severity: "high",
      },
      policy: watchPagePolicy(finishedEntry, watch),
    });
    await binding.attach(watch.incidentId!);
    assert.equal(await tx.detection.alert(alertIdentity(event)), undefined);
    await tx.signals.insert(event);
    await tx.work.enqueue("job", {
      id: `signal.process:${event.id}`,
      kind: "signal.process",
      idempotencyKey: `signal.process:${event.id}`,
      dueAt: tx.now,
      payload: { signalId: event.id },
    });
    guard.assertCommittable();
    guard.close();
  });
  const lease = await detection.configuration.paging.foundation.claim({
    workspaceId: scope,
    queue: "job",
    kinds: ["signal.process"],
    token: randomUUID(),
    leaseMs: 60000,
  });
  assert.ok(lease);
  await new SignalProcessing(detection).process(lease);
  await detection.transaction(scope, async (tx) => {
    const alert = (await tx.detection.alert(alertIdentity(event)))!;
    assert.equal(alert.incidentId, watch.incidentId);
    assert.equal(alert.lastSignalId, event.id);
    assert.equal(alert.observedAt, event.observedAt);
    assert.equal((await tx.incidents.list({ limit: 100 })).items.length, 2); // seeded incident plus watch
    const guard = new TransactionGuard();
    const binding = await watchIncidentCorrelation(tx, guard).lock(watch);
    assert.equal(binding.incidentId, watch.incidentId);
    await binding.attach(watch.incidentId!);
    guard.assertCommittable();
    guard.close();
    await assert.rejects(
      binding.attach(watch.incidentId!),
      /closed_transaction/,
    );
  });
});
