import test from "node:test";
import assert from "node:assert/strict";
import { proposalCapture } from "./conformance/proposal-fixture.js";
import { at } from "./conformance/rule-backtest-fixture.js";
import { MemoryFoundationRepository } from "./conformance/memory.js";
import {
  ruleProposalSchema,
  type RuleProposal,
} from "../src/contracts/rule-proposal.js";
import type {
  RuleReplayRun,
  StoredRuleReplaySnapshot,
} from "../src/contracts/replay-run.js";
import type { RuleBacktestRecord } from "../src/contracts/backtest-record.js";
import type { WorkLease } from "../src/application/jobs/ports.js";
import type {
  RuleProposalRepository,
  RuleProposalTransaction,
} from "../src/application/rules/proposal-ports.js";
import { withRuleProposals } from "../src/application/rules/proposal-transaction.js";
import { RuleProposalEvaluation } from "../src/application/rules/proposal-evaluation.js";
import { ruleProposalEvaluationJob } from "../src/application/rules/proposal-jobs.js";
import { replayRuleWindows } from "../src/application/rules/replay.js";
import { summarizeRuleBacktest } from "../src/application/rules/backtest.js";
import { workspaceSchema } from "../src/contracts/entities.js";
const unused = async (): Promise<never> => {
  throw new Error("Unexpected operation");
};
async function setup() {
  const source = proposalCapture(),
    scope = source.workspaceId;
  const destination = {
    provider: "ollama",
    model: "local",
    location: "local",
    origin: "http://localhost:11434",
  };
  const initial = ruleProposalSchema.parse({
    id: "proposal",
    workspaceId: scope,
    requestedBy: "operator",
    originLabelId: "label",
    sourceSnapshotId: source.snapshot.snapshotId,
    sourceInputHash: source.inputHash,
    candidateId: "new",
    profileId: "model",
    profileRevision: 1,
    destination,
    revision: 3,
    status: "evaluating",
    failure: null,
    fullRunId: null,
    heldOutRunId: null,
    heldOut: "insufficient_span",
    createdAt: at(21),
    updatedAt: at(21),
    expiresAt: at(60),
    generation: {
      candidate: { ...source.snapshot.version, id: "new" },
      rationale: "Review",
      destination,
      sourceSnapshotId: source.snapshot.snapshotId,
      sourceInputHash: source.inputHash,
      trainingCutoffAt: at(10),
      usage: { modelCalls: 1, outputTokens: 1 },
      reviewable: false,
    },
  });
  type State = {
    row: RuleProposal;
    runs: RuleReplayRun[];
    snapshots: StoredRuleReplaySnapshot[];
    reports: RuleBacktestRecord[];
    scheduled: number[];
  };
  const foundation = new MemoryFoundationRepository({
    now: () => new Date(control.now),
  });
  const control = {
    now: at(22),
    claim: true,
    failSchedule: false,
    jobState: "pending" as "pending" | "failed",
  };
  await foundation.transaction(scope, async (tx) => {
    await tx.workspace.insert(
      workspaceSchema.parse({
        id: scope,
        name: "Rules",
        createdAt: at(0),
        updatedAt: at(0),
      }),
    );
  });
  await foundation.withExtensions(scope, async (_tx, ext) => {
    ext.evaluation = {
      row: initial,
      runs: [],
      snapshots: [source],
      reports: [],
      scheduled: [],
    } satisfies State;
  });
  const edit = <T>(fn: (s: State) => T) =>
    foundation.withExtensions(scope, async (_tx, ext) =>
      fn(ext.evaluation as State),
    );
  const state = () => edit((s) => structuredClone(s));
  const repository: RuleProposalRepository = {
    transaction: (tenant, fn) =>
      foundation.withExtensions(tenant, async (base, ext, guard) => {
        const s = ext.evaluation as State;
        const tx: Omit<RuleProposalTransaction, "proposals"> = {
          ...base,
          work: {
            ...base.work,
            lockClaim: async (lease) => (control.claim ? lease : undefined),
          },
          replay: {
            currentTime: async () => control.now,
            lock: async (id) =>
              structuredClone(s.runs.find((r) => r.id === id)),
            snapshot: async (id) =>
              structuredClone(
                s.snapshots.find((r) => r.snapshot.snapshotId === id),
              ),
            append: unused,
            save: unused,
          },
          capture: {
            reserve: async () => {},
            evidence: unused,
            insert: async (snapshot, run) => {
              s.snapshots.push(snapshot);
              s.runs.push(run);
            },
          },
          reports: {
            chunks: unused,
            labels: unused,
            get: async (id) =>
              structuredClone(s.reports.find((r) => r.runId === id)),
            insert: unused,
          },
        };
        return fn(
          withRuleProposals(
            tx,
            {
              evaluatingIds: async () =>
                s.row.status === "evaluating" ? [s.row.id] : [],
              workState: async () => control.jobState,
              currentTime: async () => control.now,
              lock: async (id) =>
                id === s.row.id ? structuredClone(s.row) : undefined,
              insert: unused,
              save: async (row, revision) => {
                if (s.row.revision !== revision) return false;
                s.row = structuredClone(row);
                return true;
              },
              label: unused,
              profile: unused,
              lockClaim: unused,
              releaseClaim: unused,
              scheduleEvaluation: async (row) => {
                if (control.failSchedule)
                  throw new Error("Injected scheduling failure");
                s.scheduled.push(row.revision);
              },
            },
            guard,
          ),
        );
      }),
  };
  const lease = async (): Promise<WorkLease> => {
    const job = ruleProposalEvaluationJob((await state()).row);
    return {
      ...job,
      workspaceId: scope,
      queue: "job",
      token: "token",
      attempt: 1,
      leaseExpiresAt: at(23),
    };
  };
  const finish = () =>
    edit((s) => {
      const run = s.runs[0]!,
        stored = s.snapshots.find(
          (r) => r.snapshot.snapshotId === run.snapshotId,
        )!;
      const batch = replayRuleWindows(stored.snapshot, null, {
        maxDecisions: 60,
        maxSampleVisits: 100000,
      });
      s.runs[0] = {
        ...run,
        status: "completed",
        cursor: batch.cursor,
        nextBatch: 1,
        revision: run.revision + 1,
        decisionCount: batch.decisions.length,
        updatedAt: control.now,
      };
      s.reports.push({
        workspaceId: scope,
        runId: run.id,
        snapshotId: run.snapshotId,
        inputHash: run.inputHash,
        labelHash: "a".repeat(64),
        createdAt: control.now,
        report: summarizeRuleBacktest(stored.snapshot, batch.decisions, []),
      });
    });
  return {
    state,
    edit,
    lease,
    finish,
    control,
    runner: new RuleProposalEvaluation(repository),
  };
}
test("retries cannot duplicate the replay reservation or successor job", async () => {
  const f = await setup(),
    old = await f.lease();
  await f.runner.process(old);
  await f.runner.process(old);
  const s = await f.state();
  assert.equal(s.runs.length, 1);
  assert.deepEqual(s.scheduled, [4]);
  assert.equal(s.row.status, "evaluating");
});
test("failure to schedule rolls back the candidate replay and proposal pointer", async () => {
  const f = await setup();
  f.control.failSchedule = true;
  await assert.rejects(f.runner.process(await f.lease()), /scheduling failure/);
  const s = await f.state();
  assert.equal(s.runs.length, 0);
  assert.equal(s.row.fullRunId, null);
  assert.equal(s.row.revision, 3);
});
test("polls wait for reports, then attach a sealed report without activating the candidate", async () => {
  const f = await setup();
  await f.runner.process(await f.lease());
  assert.deepEqual(await f.runner.process(await f.lease()), {
    state: "wait",
    delayMs: 60000,
  });
  await f.finish();
  await f.runner.process(await f.lease());
  const s = await f.state();
  assert.equal(s.row.status, "ready");
  assert.equal(s.row.generation?.reviewable, false);
  assert.equal(s.row.generation?.candidate.revision, 1);
});
test("failed replay jobs fail the proposal instead of pretending a report exists", async () => {
  const f = await setup();
  await f.runner.process(await f.lease());
  f.control.jobState = "failed";
  await f.runner.process(await f.lease());
  assert.equal((await f.state()).row.failure, "evaluation_failed");
});
test("expiry bounds successful polls and lost claims cannot change state", async () => {
  const f = await setup();
  f.control.claim = false;
  await f.runner.process(await f.lease());
  assert.equal((await f.state()).row.revision, 3);
  f.control.claim = true;
  f.control.now = at(60);
  await f.runner.process(await f.lease());
  assert.equal((await f.state()).row.failure, "expired");
});
test("a report for a different input rolls back readiness", async () => {
  const f = await setup();
  await f.runner.process(await f.lease());
  await f.finish();
  await f.edit((s) => {
    s.reports[0]!.inputHash = "b".repeat(64);
  });
  await assert.rejects(f.runner.process(await f.lease()));
  assert.equal((await f.state()).row.status, "evaluating");
});
test("a required held-out run is not replaced with the full report", async () => {
  const f = await setup();
  await f.runner.process(await f.lease());
  await f.finish();
  await f.edit((s) => {
    s.row.heldOut = "required";
  });
  await assert.rejects(
    f.runner.process(await f.lease()),
    /Insufficient history/,
  );
  assert.equal((await f.state()).row.status, "evaluating");
});

test("maintenance frees orphaned evaluation capacity, but preserves active work", async () => {
  const f = await setup();
  assert.equal(
    await f.runner.recover((await f.state()).row.workspaceId),
    false,
  );
  f.control.jobState = "failed";
  assert.equal(await f.runner.recover((await f.state()).row.workspaceId), true);
  assert.equal((await f.state()).row.failure, "evaluation_failed");
  assert.equal(
    await f.runner.recover((await f.state()).row.workspaceId),
    false,
  );
});
test("maintenance expires an overdue pending evaluation", async () => {
  const f = await setup();
  f.control.now = at(60);
  assert.equal(await f.runner.recover((await f.state()).row.workspaceId), true);
  assert.equal((await f.state()).row.failure, "expired");
});
