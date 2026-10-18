import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fixture, at } from "./conformance/rule-retained-fixture.js";
import { label } from "./conformance/rule-backtest-fixture.js";
import { replayRuleWindows } from "../src/application/rules/replay.js";
import { summarizeRuleBacktest } from "../src/application/rules/backtest.js";
import {
  buildRuleReviewEvidence,
  ruleReviewedLabelHash,
} from "../src/application/rules/review-evidence.js";
import {
  storedRuleReplaySnapshotSchema,
  ruleReplayRunSchema,
} from "../src/contracts/replay-run.js";
import { ruleBacktestRecordSchema } from "../src/contracts/backtest-record.js";
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function setup() {
  const snapshot = fixture(),
    version = snapshot.version,
    scope = version.definition.workspaceId;
  const replay = replayRuleWindows(snapshot, null, {
    maxDecisions: 60,
    maxSampleVisits: 100000,
  });
  const stored = storedRuleReplaySnapshotSchema.parse({
    workspaceId: scope,
    snapshot,
    inputHash: hash(snapshot),
  });
  const run = ruleReplayRunSchema.parse({
    id: "run",
    workspaceId: scope,
    snapshotId: snapshot.snapshotId,
    inputHash: stored.inputHash,
    revision: 2,
    status: "completed",
    nextBatch: 1,
    cursor: replay.cursor,
    decisionCount: replay.decisions.length,
    createdAt: at(7),
    updatedAt: at(8),
  });
  const report = ruleBacktestRecordSchema.parse({
    workspaceId: scope,
    runId: run.id,
    snapshotId: snapshot.snapshotId,
    inputHash: stored.inputHash,
    labelHash: ruleReviewedLabelHash([]),
    createdAt: at(9),
    report: summarizeRuleBacktest(snapshot, replay.decisions, []),
  });
  const fresh = structuredClone(snapshot.retained!);
  fresh.history.snapshotAt = at(10);
  fresh.history.visibleAt = at(10);
  const selected = {
    run,
    snapshot: stored,
    report,
    fresh,
    labels: [] as ReturnType<typeof label>[],
  };
  const read = () =>
    buildRuleReviewEvidence(
      version,
      at(10),
      fresh.measurementHash,
      fresh.policyFacts,
      selected,
    );
  return { version, selected, read };
}
test("read clocks may advance without invalidating the fixed historical evidence", () => {
  const { read } = setup(),
    evidence = read();
  assert.equal(evidence.policyKnown, true);
  assert.equal(evidence.policyEnabled, true);
  assert.ok(evidence.fingerprint.reportHash);
  assert.equal(evidence.report?.report.precision.value, null);
});
test("pruned or changed historical receipts require a new backtest", () => {
  const a = setup();
  a.selected.fresh.history.receipts.pop();
  assert.throws(a.read, /Coverage or measurement changed/);
  const b = setup();
  b.selected.fresh.history.receipts[0]!.sample.receivedAt = at(9);
  assert.throws(b.read, /Coverage or measurement changed/);
});
test("historical policy loss is not masked by unchanged coverage receipts", () => {
  const a = setup();
  a.selected.fresh.policyFacts.pop();
  assert.throws(a.read, /Coverage or measurement changed/);
});
test("a measurement edit invalidates the selected report", () => {
  const a = setup();
  a.selected.fresh.measurementHash = "b".repeat(64);
  assert.throws(a.read, /Coverage or measurement changed/);
});
test("snapshot tampering and incomplete runs fail closed", () => {
  const a = setup();
  a.selected.snapshot.inputHash = "b".repeat(64);
  assert.throws(a.read, /intact completed report/);
  const b = setup();
  b.selected.run.status = "running";
  assert.throws(b.read, /intact completed report/);
});
test("report completion must match the captured range and decision count", () => {
  const a = setup();
  a.selected.run.decisionCount++;
  assert.throws(a.read, /completion does not match/);
  const b = setup();
  b.selected.report.createdAt = at(11);
  assert.throws(b.read, /completion does not match/);
});
test("fresh labels cannot replace the reviewed labels sealed into the report", () => {
  const a = setup(),
    l = label("new", 3, 4);
  l.createdAt = at(7);
  l.updatedAt = at(9);
  l.reviewedAt = at(9);
  a.selected.labels.push(l);
  assert.throws(a.read, /Reviewed labels changed/);
});
test("cross-workspace evidence is rejected", () => {
  const a = setup();
  a.selected.fresh.history.workspaceId =
    "other" as typeof a.selected.fresh.history.workspaceId;
  assert.throws(a.read, /scope_violation/);
});
test("future current-policy facts cannot authorize activation", () => {
  const a = setup();
  a.selected.fresh.policyFacts[0]!.recordedAt = at(11);
  assert.throws(a.read, /Future policy fact/);
});
test("unknown policy remains unknown when shadow has no selected report", () => {
  const { version } = setup();
  const result = buildRuleReviewEvidence(
    version,
    at(10),
    "a".repeat(64),
    [],
    null,
  );
  assert.equal(result.policyKnown, false);
  assert.equal(result.policyEnabled, false);
  assert.equal(result.report, null);
});
test("label fingerprints retain the persisted projection and deterministic ordering", () => {
  const labels = [label("z", 3, 4), label("a", 5, 6)];
  const expected = hash(
    [...labels].reverse().map((l) => ({
      id: l.id,
      revision: l.revision,
      reviewedAt: l.reviewedAt,
      outcome: l.outcome,
      startedAt: l.startedAt,
      endedAt: l.endedAt,
    })),
  );
  assert.equal(ruleReviewedLabelHash(labels), expected);
  assert.equal(ruleReviewedLabelHash([...labels].reverse()), expected);
});
