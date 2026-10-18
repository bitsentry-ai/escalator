import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  workspaceIdSchema,
  ruleLiveRecordSchema,
  ruleHistorySnapshotSchema,
  scheduleSchema,
  schedulePreviewSchema,
  configuredPolicySchema,
  serviceEnvironmentSchema,
  type RuleLiveRecord,
} from "../src/contracts/index.js";
import {
  LiveRuleEvaluation,
  enqueueRuleEvaluation,
  ruleEvaluationJobId,
} from "../src/application/rules/live.js";
import { DurableWorkRunner } from "../src/application/jobs/runner.js";
import { pagingWorkId } from "../src/application/paging/work-ids.js";
import { resolvePageInTransaction } from "../src/application/paging/resolve.js";
import { MemoryRuleLiveRepository } from "./conformance/memory-rule-live.js";
import { seedPagingFixture } from "./conformance/paging.js";
const at = (minute: number) =>
  new Date(Date.parse("2026-10-07T00:00:00Z") + minute * 60000).toISOString();
async function fixture(
  mode: RuleLiveRecord["mode"] = "active",
  persistenceSeconds = 0,
) {
  const scope = workspaceIdSchema.parse(`rules-${randomUUID()}`);
  let minute = 3.25,
    healthy = false;
  const repository = new MemoryRuleLiveRepository(() => new Date(at(minute)));
  await repository.detection.transaction(scope, async (tx) => {
    await seedPagingFixture(tx);
    const schedule = scheduleSchema.parse({
      id: "schedule",
      workspaceId: scope,
      serviceId: "api",
      name: "Schedule",
      version: 1,
      enabled: true,
      rotations: [],
      overrides: [],
    });
    await tx.configuration.schedules.put(schedule, null);
    const preview = schedulePreviewSchema.parse({
      id: "preview",
      workspaceId: scope,
      serviceId: "api",
      scheduleId: schedule.id,
      scheduleVersion: 1,
      createdAt: tx.now,
      startsAt: at(0),
      endsAt: at(60),
      intervals: [{ startsAt: at(0), endsAt: at(60), assignment: null }],
    });
    await tx.configuration.previews.insert(preview);
    const policy = configuredPolicySchema.parse({
      ...(await tx.pages.get("page"))!.policy,
      primaryScheduleId: schedule.id,
      peerScheduleId: schedule.id,
      enabled: true,
      primaryPreviewId: preview.id,
      peerPreviewId: preview.id,
    });
    await tx.configuration.policies.put(policy, null);
    await tx.detection.putBinding(
      serviceEnvironmentSchema.parse({
        id: "binding",
        workspaceId: scope,
        serviceId: "api",
        environmentId: "prod",
        version: 1,
        enabled: true,
        policyId: policy.id,
        createdAt: tx.now,
        updatedAt: tx.now,
      }),
      null,
    );
  });
  const initial = ruleLiveRecordSchema.parse({
    version: {
      id: "rule",
      revision: 1,
      definition: {
        workspaceId: scope,
        serviceId: "api",
        environmentId: "prod",
        languageVersion: 1,
        selector: { kind: "probe", streamId: "probe", field: "failure" },
        aggregation: "maximum",
        windowSeconds: 60,
        stepSeconds: 60,
        collectionDelaySeconds: 60,
        minimumSamples: 1,
        trigger: { operator: "gte", value: 1 },
        recovery: { operator: "lt", value: 1 },
        persistenceSeconds,
        recoverySeconds: 0,
        cooldownSeconds: 60,
        severity: "high",
      },
    },
    generation: 1,
    revision: 1,
    mode,
    title: "Checkout probe failures",
    measurementHash: "a".repeat(64),
    state: null,
    incidentId: null,
    dueAt: at(3),
    jobId: ruleEvaluationJobId(scope, "rule", 1, at(3)),
  });
  await repository.seed(initial);
  repository.history = async (workspaceId, query) =>
    ruleHistorySnapshotSchema.parse({
      workspaceId,
      serviceId: query.serviceId,
      environmentId: query.environmentId,
      kind: query.kind,
      streamId: query.streamId,
      snapshotAt: at(minute),
      startAt: query.startAt,
      endAt: query.endAt,
      visibleAt: query.visibleAt,
      complete: true,
      configurations: [
        {
          version: 1,
          effectiveAt: at(0),
          recordedAt: at(0),
          enabled: true,
          anchorAt: at(0),
          stepSeconds: 60,
          measurementHash: initial.measurementHash,
        },
      ],
      receipts: [
        {
          version: 1,
          sample: {
            workspaceId,
            serviceId: query.serviceId,
            environmentId: query.environmentId,
            id: `sample-${Date.parse(query.endAt)}`,
            kind: "probe",
            streamId: "probe",
            slotAt: query.endAt,
            observedAt: new Date(Date.parse(query.endAt) + 6000).toISOString(),
            receivedAt: new Date(Date.parse(query.endAt) + 12000).toISOString(),
            usable: true,
            success: healthy,
            durationMs: 6000,
          },
        },
      ],
    });
  await repository.transaction(scope, (tx) =>
    enqueueRuleEvaluation(tx, initial),
  );
  const work = repository.detection.configuration.paging.foundation;
  const runner = new LiveRuleEvaluation(repository);
  const claim = async () => {
    const lease = await work.claim({
      workspaceId: scope,
      queue: "job",
      kinds: ["rules.evaluate"],
      token: randomUUID(),
      leaseMs: 30000,
    });
    assert.ok(lease);
    return lease;
  };
  const run = async () => {
    const lease = await claim();
    const result = await runner.process(lease);
    assert.equal(await work.settle(lease, result), true);
    return lease;
  };
  const current = () =>
    repository.transaction(scope, (tx) => tx.rules.lock("rule"));
  return {
    scope,
    repository,
    initial,
    runner,
    work,
    claim,
    run,
    current,
    setMinute: (value: number) => {
      minute = value;
    },
    setHealthy: (value: boolean) => {
      healthy = value;
    },
  };
}
test("a live rule opens one atomic page and replaying a settled lease cannot duplicate it", async () => {
  const f = await fixture(),
    lease = await f.run(),
    row = (await f.current())!;
  assert.equal(row.revision, 2);
  assert.equal(row.state?.activeSince, at(3));
  assert.ok(row.incidentId);
  assert.equal(row.dueAt, at(4));
  const incident = await f.repository.transaction(f.scope, (tx) =>
    tx.incidents.get(row.incidentId!),
  );
  assert.equal(incident?.title, "Checkout probe failures");
  assert.equal((await f.repository.decisions(f.scope)).length, 1);
  await f.runner.process(lease);
  assert.deepEqual(await f.current(), row);
  assert.equal((await f.repository.decisions(f.scope)).length, 1);
});
test("next-job failure rolls back the incident, decision and detector state together", async () => {
  const f = await fixture(),
    lease = await f.claim();
  f.repository.failNextJob = true;
  await assert.rejects(f.runner.process(lease), /next-job failure/);
  assert.deepEqual(await f.current(), f.initial);
  assert.deepEqual(await f.repository.decisions(f.scope), []);
  const id = pagingWorkId(f.scope, "rule-incident", "rule", "1", at(3));
  assert.equal(
    await f.repository.transaction(f.scope, (tx) => tx.incidents.get(id)),
    undefined,
  );
  f.repository.failNextJob = false;
  await f.runner.process(lease);
  assert.equal((await f.current())!.revision, 2);
});
test("shadow detects opening and recovery without creating a page", async () => {
  const f = await fixture("shadow");
  await f.run();
  assert.equal((await f.current())!.state?.activeSince, at(3));
  assert.equal((await f.current())!.incidentId, null);
  f.setMinute(4.25);
  f.setHealthy(true);
  await f.run();
  assert.equal((await f.current())!.state?.activeSince, null);
  assert.deepEqual(
    (await f.repository.decisions(f.scope)).map((row) => row.transition.action),
    ["opened", "recovered"],
  );
  const id = pagingWorkId(f.scope, "rule-incident", "rule", "1", at(3));
  assert.equal(
    await f.repository.transaction(f.scope, (tx) => tx.incidents.get(id)),
    undefined,
  );
});
test("unknown history or policy cannot clear an active incident", async () => {
  for (const policy of [false, true]) {
    const f = await fixture();
    await f.run();
    const id = (await f.current())!.incidentId!;
    f.setMinute(4.25);
    f.setHealthy(true);
    if (policy) f.repository.known = false;
    else {
      const history = f.repository.history;
      f.repository.history = async (...args) => ({
        ...(await history(...args)),
        complete: false,
      });
    }
    await f.run();
    assert.equal((await f.current())!.incidentId, id);
    assert.equal(
      (await f.repository.transaction(f.scope, (tx) => tx.incidents.get(id)))!
        .resolvedAt,
      null,
    );
  }
});
test("manual resolution does not reopen the still-active detector episode", async () => {
  const f = await fixture();
  await f.run();
  const id = (await f.current())!.incidentId!;
  await f.repository.transaction(f.scope, (tx) =>
    resolvePageInTransaction(tx, id, { kind: "system", component: "fixture" }),
  );
  f.setMinute(4.25);
  await f.run();
  assert.equal((await f.current())!.incidentId, id);
  assert.equal(
    (await f.repository.decisions(f.scope)).at(-1)!.transition.action,
    "none",
  );
  f.setHealthy(true);
  f.setMinute(5.25);
  await f.run();
  assert.equal((await f.current())!.incidentId, null);
});
test("an overwritten caller payload cannot change the persisted generation or decision", async () => {
  const f = await fixture(),
    lease = await f.claim();
  await f.runner.process({
    ...lease,
    payload: { ruleId: "rule", generation: 99, dueAt: at(9) },
  });
  assert.equal((await f.current())!.state?.lastDecisionAt, at(3));
});
test("wrong lease token cannot evaluate a rule", async () => {
  const f = await fixture(),
    lease = await f.claim();
  await f.runner.process({ ...lease, token: "wrong" });
  assert.deepEqual(await f.current(), f.initial);
});
test("overdue ticks restart persistence instead of crediting unobserved minutes", async () => {
  const f = await fixture("active", 120);
  await f.run();
  f.setMinute(6.25);
  await f.run();
  assert.equal((await f.current())!.state?.triggerSince, at(6));
  assert.equal((await f.current())!.incidentId, null);
  f.setMinute(7.25);
  await f.run();
  assert.equal((await f.current())!.incidentId, null);
  f.setMinute(8.25);
  await f.run();
  assert.ok((await f.current())!.incidentId);
});
test("lease expiry during retained-data reads rolls back all writes", async () => {
  const f = await fixture(),
    lease = await f.claim(),
    history = f.repository.history;
  f.repository.history = async (...args) => {
    const result = await history(...args);
    f.setMinute(3.8);
    return result;
  };
  await assert.rejects(f.runner.process(lease), /lease expired/);
  assert.deepEqual(await f.current(), f.initial);
  assert.deepEqual(await f.repository.decisions(f.scope), []);
});
test("disabled and maintenance policies suppress new incidents", async () => {
  for (const maintenance of [false, true]) {
    const f = await fixture();
    f.repository.enabled = maintenance;
    f.repository.maintenance = maintenance;
    await f.run();
    assert.equal((await f.current())!.incidentId, null);
    assert.equal(
      (await f.repository.decisions(f.scope))[0]!.transition.status,
      "suppressed",
    );
  }
});
test("evaluation cannot rewrite activation bindings, even if its primitive error is caught", async () => {
  const f = await fixture();
  await assert.rejects(
    f.repository.transaction(f.scope, async (tx) => {
      const row = (await tx.rules.lock("rule"))!;
      try {
        await tx.rules.save(
          { ...row, generation: 2, revision: 2, dueAt: at(4) },
          1,
        );
      } catch {
        /* caller cannot unpoison */
      }
      await tx.audit.append({
        id: "should-not-commit",
        workspaceId: f.scope,
        actor: { kind: "system", component: "fixture" },
        action: "fixture",
        subjectType: "rule",
        subjectId: "rule",
        recordedAt: tx.now,
        metadata: {},
      });
    }),
    /revision conflict/,
  );
  assert.deepEqual(await f.current(), f.initial);
});
test("runtime validation rejects an active episode without its page link", async () => {
  const f = await fixture();
  await f.run();
  const row = (await f.current())!;
  assert.equal(
    ruleLiveRecordSchema.safeParse({ ...row, incidentId: null }).success,
    false,
  );
  assert.equal(
    ruleLiveRecordSchema.safeParse({ ...row, mode: "shadow" }).success,
    false,
  );
});

test("durable live evaluation and bounded replay produce identical episode decisions", async () => {
  const f = await fixture("active");
  const samples: import("../src/contracts/index.js").RuleSample[] = [];
  const original = f.repository.history;
  f.repository.history = async (scope, query) => {
    const history = await original(scope, query);
    samples.push(...history.receipts.map((receipt) => receipt.sample));
    return history;
  };
  for (const minute of [3, 4, 5, 6]) {
    f.setMinute(minute + 0.25);
    f.setHealthy(minute >= 5);
    await f.run();
  }
  const { replayRuleWindows } =
    await import("../src/application/rules/replay.js");
  const replay = replayRuleWindows(
    {
      snapshotId: "same-retained-fixture",
      snapshotAt: at(7),
      version: f.initial.version,
      firstDecisionAt: at(3),
      lastDecisionAt: at(6),
      complete: true,
      samples,
      coverage: [
        { startAt: at(3), endAt: at(7), recordedAt: at(0), state: "complete" },
      ],
      policies: [
        {
          startAt: at(3),
          endAt: at(7),
          recordedAt: at(0),
          enabled: true,
          maintenance: false,
        },
      ],
    },
    null,
    { maxDecisions: 10, maxSampleVisits: 100 },
  );
  assert.equal(replay.status, "complete");
  assert.deepEqual(
    replay.decisions,
    (await f.repository.decisions(f.scope)).map((row) => row.transition),
  );
  assert.deepEqual(
    replay.decisions.map((row) => row.action),
    ["opened", "none", "recovered", "none"],
  );
});

test("an evaluation that fails on every attempt stays pending and resumes the rule", async () => {
  const f = await fixture();
  const runner = new DurableWorkRunner(
    f.work,
    {
      job: new Map([["rules.evaluate", (lease) => f.runner.process(lease)]]),
      outbox: new Map(),
    },
    {
      leaseMs: 30000,
      timeoutMs: 20000,
      maxAttempts: 5,
      retryBaseMs: 1000,
      retryMaxMs: 60000,
      token: randomUUID,
      random: () => 0.5,
    },
  );
  f.repository.failNextJob = true;
  const outcomes = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    outcomes.push(await runner.runOne(f.scope, "job"));
    f.setMinute(4.5 + attempt * 1.25);
  }
  assert.deepEqual(outcomes, ["retry", "retry", "retry", "retry", "wait"]);
  assert.deepEqual(await f.current(), f.initial);
  f.repository.failNextJob = false;
  assert.equal(await runner.runOne(f.scope, "job"), "completed");
  const row = (await f.current())!;
  assert.equal(row.revision, 2);
  assert.ok(row.incidentId);
  assert.ok(Date.parse(row.dueAt) > Date.parse(at(9)));
});
