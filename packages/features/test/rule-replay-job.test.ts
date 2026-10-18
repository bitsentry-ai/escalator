import test from "node:test";
import assert from "node:assert/strict";
import { workspaceIdSchema } from "../src/contracts/identity.js";
import { workspaceSchema } from "../src/contracts/entities.js";
import {
  storedRuleReplaySnapshotSchema,
  ruleReplayRunSchema,
} from "../src/contracts/replay-run.js";
import {
  RuleReplayExecution,
  enqueueRuleReplay,
} from "../src/application/rules/replay-job.js";
import { replayRuleWindows } from "../src/application/rules/replay.js";
import { MemoryRuleReplayRepository } from "./conformance/memory-rule-replay.js";
const at = (minute: number) =>
  new Date(Date.parse("2026-10-07T00:00:00Z") + minute * 60000).toISOString();
async function fixture() {
  const scope = workspaceIdSchema.parse("org-replay"),
    repository = new MemoryRuleReplayRepository(() => new Date(at(200)));
  const source = storedRuleReplaySnapshotSchema.parse({
    workspaceId: scope,
    inputHash: "a".repeat(64),
    snapshot: {
      snapshotId: "snapshot",
      snapshotAt: at(190),
      firstDecisionAt: at(1),
      lastDecisionAt: at(130),
      complete: true,
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
          minimumSamples: 1,
          trigger: { operator: "gte", value: 1 },
          recovery: { operator: "lt", value: 1 },
          persistenceSeconds: 0,
          recoverySeconds: 0,
          cooldownSeconds: 0,
          severity: "high",
        },
      },
      samples: Array.from({ length: 130 }, (_, i) => ({
        workspaceId: scope,
        serviceId: "api",
        environmentId: "prod",
        kind: "probe",
        streamId: "probe",
        id: `sample-${i}`,
        observedAt: at(i + 1),
        receivedAt: at(i + 1),
        usable: true,
        success: i < 60 || i >= 90,
        durationMs: 10,
      })),
      coverage: [
        {
          startAt: at(0),
          endAt: at(131),
          recordedAt: at(0),
          state: "complete",
        },
      ],
      policies: [
        {
          startAt: at(0),
          endAt: at(131),
          recordedAt: at(0),
          enabled: true,
          maintenance: false,
        },
      ],
    },
  });
  const row = ruleReplayRunSchema.parse({
    id: "run",
    workspaceId: scope,
    snapshotId: "snapshot",
    inputHash: source.inputHash,
    revision: 1,
    status: "queued",
    nextBatch: 0,
    cursor: null,
    decisionCount: 0,
    createdAt: at(200),
    updatedAt: at(200),
  });
  await repository.foundation.transaction(scope, async (tx) => {
    await tx.workspace.insert(
      workspaceSchema.parse({
        id: scope,
        name: "Replay",
        createdAt: at(0),
        updatedAt: at(0),
      }),
    );
  });
  await repository.seed(row, source);
  await repository.transaction(scope, (tx) => enqueueRuleReplay(tx, row));
  let claimNumber = 0;
  const claim = async () => {
    const value = await repository.foundation.claim({
      workspaceId: scope,
      queue: "job",
      token: `token-${claimNumber++}`,
      leaseMs: 60000,
      kinds: ["rules.replay"],
    });
    assert.ok(value);
    return value;
  };
  return {
    scope,
    repository,
    source,
    row,
    claim,
    execution: new RuleReplayExecution(repository),
  };
}
test("restart resumes immutable batches and equals one-shot replay", async () => {
  const f = await fixture();
  for (let i = 0; i < 3; i++) {
    const lease = await f.claim();
    const result = await new RuleReplayExecution(f.repository).process(lease);
    assert.equal(await f.repository.foundation.settle(lease, result), true);
  }
  const state = await f.repository.state(f.scope);
  assert.equal(state.runs[0]!.status, "completed");
  assert.equal(state.runs[0]!.decisionCount, 130);
  assert.deepEqual(
    state.chunks.flatMap((c) => c.decisions),
    replayRuleWindows(f.source.snapshot, null, {
      maxDecisions: 1440,
      maxSampleVisits: 1000000,
    }).decisions,
  );
  assert.equal(state.chunks.length, 3);
});
test("a duplicate claimed job cannot append the same batch twice", async () => {
  const f = await fixture(),
    lease = await f.claim();
  await f.execution.process(lease);
  await f.execution.process(lease);
  assert.equal((await f.repository.state(f.scope)).chunks.length, 1);
});
test("next-job failure rolls back chunk and cursor together", async () => {
  const f = await fixture(),
    lease = await f.claim();
  f.repository.failNextJob = true;
  await assert.rejects(() => f.execution.process(lease), /Injected/);
  const state = await f.repository.state(f.scope);
  assert.equal(state.chunks.length, 0);
  assert.equal(state.runs[0]!.revision, 1);
  f.repository.failNextJob = false;
  await f.execution.process(lease);
  assert.equal((await f.repository.state(f.scope)).chunks.length, 1);
});
test("expiry at commit rolls back an otherwise successful batch", async () => {
  const f = await fixture(),
    lease = await f.claim();
  f.repository.expireOnSave = true;
  await assert.rejects(() => f.execution.process(lease), /lease expired/);
  assert.equal((await f.repository.state(f.scope)).chunks.length, 0);
});
test("CAS rejection leaves no result chunk", async () => {
  const f = await fixture(),
    lease = await f.claim();
  f.repository.conflict = true;
  await assert.rejects(() => f.execution.process(lease), /revision conflict/);
  assert.equal((await f.repository.state(f.scope)).chunks.length, 0);
});
test("untrusted lease payload cannot redirect a persisted claim", async () => {
  const f = await fixture(),
    lease = await f.claim();
  await assert.rejects(
    () =>
      f.execution.process({ ...lease, payload: { runId: "other", batch: 0 } }),
    /Invalid replay claim/,
  );
  assert.equal((await f.repository.state(f.scope)).chunks.length, 0);
});
test("another tenant cannot read or advance the replay", async () => {
  const f = await fixture(),
    lease = await f.claim();
  await f.execution.process({
    ...lease,
    workspaceId: workspaceIdSchema.parse("other"),
  });
  assert.equal((await f.repository.state(f.scope)).chunks.length, 0);
});
test("caught replay-store errors still poison the surrounding transaction", async () => {
  const f = await fixture();
  await assert.rejects(() =>
    f.repository.transaction(f.scope, async (tx) => {
      await tx.replay.lock(f.row.id);
      try {
        await tx.replay.append({
          workspaceId: workspaceIdSchema.parse("other"),
          runId: f.row.id,
          batch: 0,
          snapshotId: f.row.snapshotId,
          decisions: [],
        });
      } catch {
        /* Caller cannot rescue a failed primitive. */
      }
    }),
  );
  assert.equal((await f.repository.state(f.scope)).chunks.length, 0);
});
test("escaped replay transaction handles expire after their callback", async () => {
  const f = await fixture();
  const tx = await f.repository.transaction(f.scope, async (value) => value);
  await assert.rejects(() => tx.replay.lock(f.row.id), /closed_transaction/);
});

test("replay transactions cannot dispatch notifications or unrelated work", async () => {
  const f = await fixture();
  for (const queue of ["job", "outbox"] as const)
    await assert.rejects(
      () =>
        f.repository.transaction(f.scope, (tx) =>
          tx.work.enqueue(queue, {
            id: "unrelated",
            kind: "paging.dispatch",
            idempotencyKey: "unrelated",
            dueAt: at(200),
            payload: {},
          }),
        ),
      /only replay jobs/,
    );
  await assert.rejects(
    () =>
      f.repository.transaction(f.scope, (tx) =>
        tx.work.cancel("outbox", ["delivery"]),
      ),
    /cannot cancel work/,
  );
});
