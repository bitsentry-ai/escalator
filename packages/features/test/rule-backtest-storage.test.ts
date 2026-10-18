import {
  encodeRuleReplayData,
  decodeRuleReplaySnapshot,
} from "../src/application/rules/replay-storage-codec.js";
import test from "node:test";
import assert from "node:assert/strict";
import { workspaceSchema } from "../src/contracts/entities.js";
import { workspaceIdSchema } from "../src/contracts/identity.js";
import {
  ruleReplayRunSchema,
  ruleReplayChunkSchema,
  storedRuleReplaySnapshotSchema,
} from "../src/contracts/replay-run.js";
import { ruleBacktestReportSchema } from "../src/contracts/rule-backtest.js";
import type { RuleBacktestRecord } from "../src/contracts/backtest-record.js";
import {
  RuleBacktestExecution,
  ruleBacktestJobId,
} from "../src/application/rules/backtest-job.js";
import { summarizeRuleBacktest } from "../src/application/rules/backtest.js";
import { replayRuleWindows } from "../src/application/rules/replay.js";
import { withRuleReplay } from "../src/application/rules/replay-transaction.js";
import { withRuleBacktests } from "../src/application/rules/backtest-transaction.js";
import type { RuleBacktestRepository } from "../src/application/rules/backtest-ports.js";
import {
  encodeRuleBacktest,
  decodeRuleBacktest,
} from "../src/application/rules/backtest-storage.js";
import { MemoryFoundationRepository } from "./conformance/memory.js";
import { fixture, at, label } from "./conformance/rule-backtest-fixture.js";
async function setup() {
  const scope = workspaceIdSchema.parse("org"),
    snapshot = fixture(),
    foundation = new MemoryFoundationRepository({
      now: () => new Date(at(30)),
    });
  const batch = replayRuleWindows(snapshot, null, {
    maxDecisions: 60,
    maxSampleVisits: 100000,
  });
  const stored = storedRuleReplaySnapshotSchema.parse({
    workspaceId: scope,
    snapshot,
    inputHash: "a".repeat(64),
  });
  const run = ruleReplayRunSchema.parse({
    id: "run",
    workspaceId: scope,
    snapshotId: snapshot.snapshotId,
    inputHash: stored.inputHash,
    revision: 2,
    status: "completed",
    nextBatch: 1,
    cursor: batch.cursor,
    decisionCount: batch.decisions.length,
    createdAt: at(20),
    updatedAt: at(25),
  });
  const chunk = ruleReplayChunkSchema.parse({
    workspaceId: scope,
    runId: run.id,
    snapshotId: run.snapshotId,
    batch: 0,
    decisions: batch.decisions,
  });
  const controls = {
    failInsert: false,
    expired: false,
    missingChunk: false,
    labels: [label("good", 2, 3)],
  };
  const repository: RuleBacktestRepository = {
    transaction: (tenant, work) =>
      foundation.withExtensions(tenant, async (base, extensions, guard) => {
        const reports = (extensions.reports ??= []) as RuleBacktestRecord[];
        const replay = withRuleReplay(
          base,
          {
            currentTime: async () => at(controls.expired ? 99 : 30),
            lock: async () => structuredClone(run),
            snapshot: async () => structuredClone(stored),
            append: async () => {
              throw new Error("Unexpected append");
            },
            save: async () => {
              throw new Error("Unexpected progress write");
            },
          },
          guard,
        );
        return work(
          withRuleBacktests(
            replay,
            {
              chunks: async () =>
                controls.missingChunk ? [] : [structuredClone(chunk)],
              labels: async () => structuredClone(controls.labels),
              get: async () => structuredClone(reports[0]),
              insert: async (row) => {
                reports.push(structuredClone(row));
                if (controls.failInsert)
                  throw new Error("Injected storage failure");
              },
            },
            guard,
          ),
        );
      }),
  };
  await foundation.transaction(scope, async (tx) => {
    await tx.workspace.insert(
      workspaceSchema.parse({
        id: scope,
        name: "Replay",
        createdAt: at(0),
        updatedAt: at(0),
      }),
    );
    const id = ruleBacktestJobId(scope, run.id);
    await tx.work.enqueue("job", {
      id,
      kind: "rules.backtest",
      idempotencyKey: id,
      dueAt: at(30),
      payload: { runId: run.id },
    });
  });
  const lease = await foundation.claim({
    workspaceId: scope,
    queue: "job",
    token: "claim",
    leaseMs: 60000,
    kinds: ["rules.backtest"],
  });
  assert.ok(lease);
  const reports = () =>
    foundation.withExtensions(scope, async (_base, e) =>
      structuredClone((e.reports ?? []) as RuleBacktestRecord[]),
    );
  return {
    scope,
    snapshot,
    batch,
    run,
    controls,
    foundation,
    lease,
    reports,
    runner: new RuleBacktestExecution(repository),
  };
}
test("report finalization is immutable and duplicate delivery adds no second report", async () => {
  const f = await setup();
  await f.runner.process(f.lease);
  await f.runner.process(f.lease);
  const rows = await f.reports();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.report.truePositives, 1);
  assert.equal(rows[0]!.inputHash, f.run.inputHash);
  const encoded = encodeRuleBacktest(f.scope, rows[0]!);
  assert.equal(encoded.includes("workspaceId"), false);
  assert.deepEqual(decodeRuleBacktest(f.scope, JSON.parse(encoded)), rows[0]);
});
test("storage failure and lease expiry cannot commit a partial report", async () => {
  for (const failure of ["failInsert", "expired"] as const) {
    const f = await setup();
    f.controls[failure] = true;
    await assert.rejects(() => f.runner.process(f.lease));
    assert.deepEqual(await f.reports(), []);
  }
});
test("missing chunks and retrospective labels reject report creation", async () => {
  const f = await setup();
  f.controls.missingChunk = true;
  await assert.rejects(() => f.runner.process(f.lease), /incomplete/);
  assert.deepEqual(await f.reports(), []);
  f.controls.missingChunk = false;
  f.controls.labels[0]!.reviewedAt = at(21);
  f.controls.labels[0]!.updatedAt = at(21);
  await assert.rejects(() => f.runner.process(f.lease), /Retrospective/);
  assert.deepEqual(await f.reports(), []);
});
test("coverage exposes exact unavailable decisions and strict counts reject inflated precision", () => {
  const s = fixture();
  s.samples = s.samples.filter((x) => x.observedAt !== at(4));
  const d = replayRuleWindows(s, null, {
    maxDecisions: 60,
    maxSampleVisits: 100000,
  }).decisions;
  const r = summarizeRuleBacktest(s, d, []);
  assert.equal(r.availability.firstUsableDecisionAt, at(1));
  assert.equal(r.availability.lastUsableDecisionAt, at(10));
  assert.equal(r.availability.gaps.length, 1);
  assert.equal(r.availability.gaps[0]!.range.firstDecisionAt, at(4));
  assert.equal(r.availability.gaps[0]!.range.decisions, 1);
  assert.equal(
    ruleBacktestReportSchema.safeParse({
      ...r,
      precision: { ...r.precision, value: 1 },
    }).success,
    false,
  );
  assert.equal(
    ruleBacktestReportSchema.safeParse({
      ...r,
      availability: { ...r.availability, gaps: [] },
    }).success,
    false,
  );
});

test("compact snapshots omit repeated selectors and restore old and new stored rows", () => {
  const snapshot = fixture(),
    scope = workspaceIdSchema.parse("org");
  const stored = storedRuleReplaySnapshotSchema.parse({
    workspaceId: scope,
    snapshot,
    inputHash: "a".repeat(64),
  });
  const encoded = encodeRuleReplayData(scope, "snapshot", stored),
    raw = JSON.parse(encoded);
  assert.equal(raw.snapshot.samples[0].serviceId, undefined);
  assert.equal(raw.snapshot.samples[0].kind, undefined);
  assert.deepEqual(decodeRuleReplaySnapshot(scope, raw), stored);
  const old = JSON.parse(
    JSON.stringify(stored, (key, value: unknown) =>
      key === "workspaceId" ? undefined : value,
    ),
  );
  assert.deepEqual(decodeRuleReplaySnapshot(scope, old), stored);
  raw.snapshot.samples[0].serviceId = "foreign";
  assert.throws(() => decodeRuleReplaySnapshot(scope, raw));
});
test("thirty days of retained minute probe receipts fit the stored snapshot bound", () => {
  const base = fixture();
  const selectors = {
    workspaceId: "11111111-1111-4111-8111-111111111111",
    serviceId: "22222222-2222-4222-8222-222222222222",
    environmentId: "33333333-3333-4333-8333-333333333333",
  };
  const streamId = "44444444-4444-4444-8444-444444444444";
  const receipts = Array.from({ length: 43200 }, (_, i) => ({
    version: 1,
    sample: {
      ...base.samples[0],
      ...selectors,
      streamId,
      id: `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`,
      observedAt: at(i + 1),
      receivedAt: at(i + 1),
      slotAt: at(i + 1),
      durationMs: 1000,
    },
  }));
  const stored = storedRuleReplaySnapshotSchema.parse({
    workspaceId: selectors.workspaceId,
    inputHash: "a".repeat(64),
    snapshot: {
      ...base,
      snapshotAt: at(43201),
      lastDecisionAt: at(43200),
      version: {
        ...base.version,
        definition: {
          ...base.version.definition,
          ...selectors,
          selector: { ...base.version.definition.selector, streamId },
        },
      },
      samples: [],
      coverage: [],
      policies: [],
      retained: {
        measurementHash: "a".repeat(64),
        policyFacts: [],
        policyComplete: true,
        history: {
          ...selectors,
          kind: "probe",
          streamId,
          snapshotAt: at(43201),
          startAt: at(0),
          endAt: at(43200),
          visibleAt: at(43201),
          complete: true,
          configurations: [],
          receipts,
        },
      },
    },
  });
  const encoded = encodeRuleReplayData(stored.workspaceId, "snapshot", stored);
  assert.ok(new TextEncoder().encode(encoded).byteLength < 16777216);
  assert.equal(
    decodeRuleReplaySnapshot(stored.workspaceId, JSON.parse(encoded)).snapshot
      .retained!.history.receipts.length,
    43200,
  );
});
