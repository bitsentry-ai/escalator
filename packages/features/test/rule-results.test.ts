import test from "node:test";
import assert from "node:assert/strict";
import { fixture, at } from "./conformance/rule-backtest-fixture.js";
import { ruleReplayRunSchema } from "../src/contracts/replay-run.js";
import { ruleProposalSchema } from "../src/contracts/rule-proposal.js";
import { replayRuleWindows } from "../src/application/rules/replay.js";
import { summarizeRuleBacktest } from "../src/application/rules/backtest.js";
import { encodeRuleReplayData } from "../src/application/rules/replay-storage-codec.js";
import { encodeRuleProposal } from "../src/application/rules/proposal-storage.js";
import {
  projectRuleReplayResult,
  projectRuleProposal,
  ruleResultJobId,
} from "../src/application/rules/results-projection.js";
import { ruleReplayJobId } from "../src/application/rules/replay-job.js";
import { ruleBacktestJobId } from "../src/application/rules/backtest-job.js";
function setup(completed = false) {
  const s = fixture(),
    scope = s.version.definition.workspaceId;
  const result = replayRuleWindows(s, null, {
    maxDecisions: 1440,
    maxSampleVisits: 1000000,
  });
  const row = ruleReplayRunSchema.parse({
    id: "run",
    workspaceId: scope,
    snapshotId: s.snapshotId,
    inputHash: "a".repeat(64),
    revision: completed ? 2 : 1,
    status: completed ? "completed" : "queued",
    nextBatch: completed ? 1 : 0,
    cursor: completed ? result.cursor : null,
    decisionCount: completed ? result.decisions.length : 0,
    createdAt: at(20),
    updatedAt: at(21),
  });
  const run = JSON.parse(encodeRuleReplayData(scope, "run", row));
  const snapshot = {
    snapshotId: s.snapshotId,
    inputHash: row.inputHash,
    originalRetained: false,
    version: s.version,
    firstDecisionAt: s.firstDecisionAt,
    lastDecisionAt: s.lastDecisionAt,
  };
  const r = summarizeRuleBacktest(s, result.decisions, []);
  const report = {
    runId: row.id,
    snapshotId: row.snapshotId,
    inputHash: row.inputHash,
    rule: r.rule,
    summary: {
      status: r.status,
      reason: r.reason,
      simulation: r.simulation,
      range: r.range,
      coverage: r.coverage,
      episodeCount: r.episodes.length,
      reviewedLabels: r.reviewedLabels,
      unreviewedEpisodes: r.unreviewedEpisodes,
      ambiguousEpisodes: r.ambiguousEpisodes,
      truePositives: r.truePositives,
      falsePositives: r.falsePositives,
      missedLabels: r.missedLabelIds.length,
      unevaluableLabels: r.unevaluableLabelIds.length,
      precision: r.precision,
      labelCoverage: r.labelCoverage,
    },
  };
  return { scope, run, snapshot, report };
}
test("failed durable replay work does not look queued or running", () => {
  const f = setup();
  assert.equal(
    projectRuleReplayResult(f.scope, f.run, f.snapshot, null, "failed").state,
    "failed",
  );
  assert.equal(
    projectRuleReplayResult(f.scope, f.run, f.snapshot, null, "cancelled")
      .state,
    "cancelled",
  );
  assert.equal(
    projectRuleReplayResult(f.scope, f.run, f.snapshot, null, "running").state,
    "replaying",
  );
  assert.equal(
    projectRuleReplayResult(f.scope, f.run, f.snapshot, null, "pending").state,
    "queued",
  );
});
test("absent work and completed work without its report remain unknown", () => {
  for (const complete of [false, true]) {
    const f = setup(complete);
    for (const work of [undefined, "completed"] as const)
      assert.equal(
        projectRuleReplayResult(f.scope, f.run, f.snapshot, null, work).state,
        "unknown",
      );
  }
});
test("replay completion remains reporting until a sealed report exists", () => {
  const f = setup(true);
  assert.equal(
    ruleResultJobId(f.scope, f.run),
    ruleBacktestJobId(f.scope, "run"),
  );
  assert.equal(
    projectRuleReplayResult(f.scope, f.run, f.snapshot, null, "pending").state,
    "reporting",
  );
  assert.equal(
    projectRuleReplayResult(f.scope, f.run, f.snapshot, null, "failed").state,
    "failed",
  );
  const view = projectRuleReplayResult(
    f.scope,
    f.run,
    f.snapshot,
    f.report,
    undefined,
  );
  assert.equal(view.state, "completed");
  assert.equal(view.report?.precision.value, null);
  assert.equal(view.report?.unreviewedEpisodes, 2);
  assert.equal("episodes" in view.report!, false);
  assert.equal("samples" in view, false);
});
test("next replay batch uses its own durable job identity", () => {
  const f = setup();
  assert.equal(
    ruleResultJobId(f.scope, f.run),
    ruleReplayJobId(f.scope, "run", 0),
  );
});
test("result projections reject substituted snapshot, hash, report or version", () => {
  const f = setup(true);
  assert.throws(() =>
    projectRuleReplayResult(
      f.scope,
      f.run,
      { ...f.snapshot, snapshotId: "other" },
      f.report,
      undefined,
    ),
  );
  assert.throws(() =>
    projectRuleReplayResult(
      f.scope,
      f.run,
      f.snapshot,
      { ...f.report, inputHash: "b".repeat(64) },
      undefined,
    ),
  );
  assert.throws(() =>
    projectRuleReplayResult(
      f.scope,
      f.run,
      f.snapshot,
      { ...f.report, runId: "other" },
      undefined,
    ),
  );
  assert.throws(() =>
    projectRuleReplayResult(
      f.scope,
      f.run,
      f.snapshot,
      { ...f.report, rule: { ...f.report.rule, revision: 2 } },
      undefined,
    ),
  );
  const pending = setup();
  assert.throws(() =>
    projectRuleReplayResult(
      pending.scope,
      pending.run,
      pending.snapshot,
      pending.report,
      undefined,
    ),
  );
});
test("proposal views omit model routing and credentials while retaining the candidate", () => {
  const f = setup(),
    destination = {
      provider: "ollama",
      model: "internal-model",
      location: "local",
      origin: "http://127.0.0.1:11434",
    };
  const row = ruleProposalSchema.parse({
    id: "proposal",
    workspaceId: f.scope,
    requestedBy: "operator",
    originLabelId: "label",
    sourceSnapshotId: "snapshot",
    sourceInputHash: "a".repeat(64),
    candidateId: "candidate",
    profileId: "private-profile",
    profileRevision: 1,
    revision: 3,
    status: "evaluating",
    destination,
    generation: {
      candidate: { ...fixture().version, id: "candidate" },
      rationale: "Inspect failures",
      destination,
      sourceSnapshotId: "snapshot",
      sourceInputHash: "a".repeat(64),
      trainingCutoffAt: at(8),
      usage: { modelCalls: 1, outputTokens: 10 },
      reviewable: false,
    },
    failure: null,
    fullRunId: null,
    heldOutRunId: null,
    heldOut: "required",
    createdAt: at(20),
    updatedAt: at(21),
    expiresAt: at(80),
  });
  const raw = JSON.parse(encodeRuleProposal(f.scope, row)),
    view = projectRuleProposal(f.scope, raw, "api", "prod");
  assert.equal(view.candidate?.id, "candidate");
  assert.equal(view.rationale, "Inspect failures");
  for (const name of [
    "destination",
    "profileId",
    "profileRevision",
    "sourceInputHash",
    "generation",
    "requestedBy",
    "claimToken",
  ])
    assert.equal(name in view, false);
  assert.throws(() =>
    projectRuleProposal(f.scope, raw, "other-service", "prod"),
  );
});
