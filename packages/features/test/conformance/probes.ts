import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  probeSchema,
  probeResultSchema,
  signalSourceSchema,
  workspaceIdSchema,
  type Probe,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import {
  observeProbe,
  probeJobId,
  type ProbeRepository,
  type ProbeTransaction,
  type DurableWorkStore,
} from "@bitsentry-escalator/features/application";
import { seedSignalFixture, fixtureSignal } from "./signals.js";
export interface ProbeFixture {
  repository: ProbeRepository;
  work: DurableWorkStore;
  dispose(): Promise<void>;
}
export async function seedProbeFixture(tx: ProbeTransaction): Promise<Probe> {
  await seedSignalFixture(tx);
  const original = (await tx.sources.get("source"))!;
  await tx.sources.insert(
    signalSourceSchema.parse({
      ...original,
      id: "probe-source",
      kind: "probe",
    }),
  );
  const probe = probeSchema.parse({
    id: "probe",
    workspaceId: tx.workspaceId,
    sourceId: "probe-source",
    serviceId: "service",
    environmentId: "production",
    name: "Checkout",
    version: 1,
    enabled: true,
    intervalSeconds: 60,
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
  });
  assert.equal(await tx.probes.put(probe, null), true);
  return probe;
}
export function probeConformance(
  name: string,
  create: () => Promise<ProbeFixture>,
  options: {
    skip?: string;
    register?: (name: string, run: () => Promise<void>) => unknown;
  } = {},
) {
  const register =
    options.register ??
    ((name, run) => test(name, { skip: options.skip }, run));
  const scenario = (
    title: string,
    run: (
      fixture: ProbeFixture,
      a: WorkspaceId,
      b: WorkspaceId,
    ) => Promise<void>,
  ) =>
    register(`${name}: ${title}`, async () => {
      const f = await create();
      const a = workspaceIdSchema.parse(`probe_a_${randomUUID()}`);
      const b = workspaceIdSchema.parse(`probe_b_${randomUUID()}`);
      try {
        for (const scope of [a, b])
          await f.repository.transaction(scope, seedProbeFixture);
        await run(f, a, b);
      } finally {
        await f.dispose();
      }
    });
  scenario(
    "same IDs remain scoped and cross-workspace writes poison the transaction",
    async ({ repository }, a, b) => {
      await repository.transaction(a, async (tx) => {
        const value = (await tx.probes.lock("probe"))!;
        assert.equal(
          await tx.probes.put(
            { ...value, name: "Team A", version: 2, updatedAt: tx.now },
            1,
          ),
          true,
        );
      });
      assert.equal(
        await repository.transaction(
          b,
          async (tx) => (await tx.probes.get("probe"))?.name,
        ),
        "Checkout",
      );
      await assert.rejects(
        repository.transaction(a, async (tx) => {
          const value = (await tx.probes.get("probe"))!;
          await assert.rejects(
            tx.probes.put(
              { ...value, workspaceId: b, version: 3, updatedAt: tx.now },
              2,
            ),
          );
        }),
      );
      assert.equal(
        await repository.transaction(
          a,
          async (tx) => (await tx.probes.get("probe"))?.version,
        ),
        2,
      );
    },
  );
  scenario(
    "probe configuration is versioned with immutable identity and one source owner",
    async ({ repository }, a) => {
      const writes = await Promise.all(
        ["First", "Second"].map((name) =>
          repository.transaction(a, async (tx) => {
            const probe = (await tx.probes.lock("probe"))!;
            return tx.probes.put(
              { ...probe, name, version: 2, updatedAt: tx.now },
              1,
            );
          }),
        ),
      );
      assert.deepEqual(writes.sort(), [false, true]);
      await assert.rejects(
        repository.transaction(a, async (tx) => {
          const probe = (await tx.probes.get("probe"))!;
          await tx.probes.put(
            {
              ...probe,
              id: "second",
              version: 1,
              createdAt: tx.now,
              updatedAt: tx.now,
            },
            null,
          );
        }),
      );
      await assert.rejects(
        repository.transaction(a, async (tx) => {
          const probe = (await tx.probes.get("probe"))!;
          await tx.probes.put(
            { ...probe, sourceId: "source", version: 3, updatedAt: tx.now },
            2,
          );
        }),
      );
    },
  );
  scenario(
    "result, threshold, signal, schedule and work roll back together",
    async ({ repository, work }, a) => {
      await assert.rejects(
        repository.transaction(a, async (tx) => {
          const probe = (await tx.probes.lock("probe"))!;
          const result = probeResultSchema.parse({
            id: "run",
            workspaceId: a,
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
          const dueAt = tx.now;
          const jobId = probeJobId(a, probe.id, 1, dueAt);
          await tx.probes.putSchedule({
            probeId: probe.id,
            workspaceId: a,
            probeVersion: 1,
            jobId,
            dueAt,
          });
          await tx.work.enqueue("job", {
            id: jobId,
            kind: "probe.execute",
            idempotencyKey: jobId,
            payload: { probeId: probe.id },
            dueAt,
          });
          await tx.signals.insert({
            ...fixtureSignal(tx),
            sourceId: probe.sourceId,
          });
          await tx.audit.append({
            id: "probe-result",
            workspaceId: a,
            actor: { kind: "system", component: "probes" },
            action: "probe.observed",
            subjectType: "probe",
            subjectId: probe.id,
            recordedAt: tx.now,
            metadata: {},
          });
          throw new Error("rollback");
        }),
      );
      await repository.transaction(a, async (tx) => {
        assert.equal(await tx.probes.result("run"), undefined);
        assert.equal(await tx.probes.state("probe"), undefined);
        assert.equal(await tx.probes.schedule("probe"), undefined);
        assert.equal(await tx.signals.get("signal"), undefined);
        assert.equal((await tx.audit.list({ limit: 100 })).items.length, 0);
      });
      assert.equal(
        await work.claim({
          workspaceId: a,
          queue: "job",
          token: randomUUID(),
          leaseMs: 30000,
          kinds: ["probe.execute"],
        }),
        undefined,
      );
    },
  );
  scenario(
    "result receipts are immutable and state cannot be invented or replayed",
    async ({ repository }, a, b) => {
      await repository.transaction(a, async (tx) => {
        const probe = (await tx.probes.lock("probe"))!;
        const result = probeResultSchema.parse({
          id: "run",
          workspaceId: a,
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
      });
      await assert.rejects(
        repository.transaction(a, async (tx) => {
          await tx.probes.lock("probe");
          const result = (await tx.probes.result("run"))!;
          await tx.probes.recordResult({
            ...result,
            observedAt: tx.now,
            outcome: "healthy",
            reason: "assertions_passed",
            statusCode: 200,
          });
        }),
      );
      await assert.rejects(
        repository.transaction(a, async (tx) => {
          await tx.probes.lock("probe");
          const state = (await tx.probes.state("probe"))!;
          await tx.probes.putState({ ...state, active: false });
        }),
      );
      await repository.transaction(b, async (tx) => {
        assert.equal(await tx.probes.result("run"), undefined);
        assert.equal(await tx.probes.state("probe"), undefined);
        assert.equal(
          (await tx.probes.results("probe", { limit: 1 })).items.length,
          0,
        );
      });
      await repository.transaction(a, async (tx) => {
        assert.equal((await tx.probes.result("run"))?.outcome, "failed");
        assert.equal((await tx.probes.state("probe"))?.active, true);
        assert.equal(
          (await tx.probes.results("probe", { limit: 1 })).items.length,
          1,
        );
      });
    },
  );
  scenario(
    "schedule writes require the probe lock and canonical versioned job identity",
    async ({ repository }, a, b) => {
      await assert.rejects(
        repository.transaction(a, async (tx) => {
          await tx.probes.putSchedule({
            probeId: "probe",
            workspaceId: a,
            probeVersion: 1,
            jobId: "forged",
            dueAt: tx.now,
          });
        }),
      );
      await assert.rejects(
        repository.transaction(a, async (tx) => {
          await tx.probes.lock("probe");
          await tx.probes.putSchedule({
            probeId: "probe",
            workspaceId: a,
            probeVersion: 1,
            jobId: "forged",
            dueAt: tx.now,
          });
        }),
      );
      await repository.transaction(a, async (tx) => {
        await tx.probes.lock("probe");
        await tx.probes.putSchedule({
          probeId: "probe",
          workspaceId: a,
          probeVersion: 1,
          jobId: probeJobId(a, "probe", 1, tx.now),
          dueAt: tx.now,
        });
      });
      assert.equal(
        await repository.transaction(b, (tx) => tx.probes.schedule("probe")),
        undefined,
      );
    },
  );
  scenario(
    "caught repository failures roll back earlier edits and escaped handles are closed",
    async ({ repository }, a) => {
      let escaped: ProbeTransaction | undefined;
      await assert.rejects(
        repository.transaction(a, async (tx) => {
          escaped = tx;
          const value = (await tx.probes.lock("probe"))!;
          assert.equal(
            await tx.probes.put(
              { ...value, name: "Uncommitted", version: 2, updatedAt: tx.now },
              1,
            ),
            true,
          );
          await assert.rejects(tx.probes.list({ limit: 0 }));
        }),
      );
      assert.ok(escaped);
      await assert.rejects(escaped.probes.get("probe"));
      assert.equal(
        await repository.transaction(
          a,
          async (tx) => (await tx.probes.get("probe"))?.name,
        ),
        "Checkout",
      );
    },
  );
}
