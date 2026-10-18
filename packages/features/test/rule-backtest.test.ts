import test from "node:test";
import assert from "node:assert/strict";
import { ruleReplaySnapshotSchema } from "../src/contracts/rule-replay.js";
import { incidentLabelSchema } from "../src/contracts/rule-label.js";
import { replayRuleWindows } from "../src/application/rules/replay.js";
import { summarizeRuleBacktest } from "../src/application/rules/backtest.js";
const at = (minute: number) =>
  new Date(Date.parse("2026-10-07T00:00:00Z") + minute * 60000).toISOString();
const scope = { workspaceId: "org", serviceId: "api", environmentId: "prod" };
function fixture() {
  return ruleReplaySnapshotSchema.parse({
    snapshotId: "snapshot",
    snapshotAt: at(20),
    firstDecisionAt: at(1),
    lastDecisionAt: at(10),
    complete: true,
    version: {
      id: "rule",
      revision: 1,
      definition: {
        ...scope,
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
    samples: Array.from({ length: 10 }, (_, i) => ({
      ...scope,
      kind: "probe",
      streamId: "probe",
      id: `s-${i}`,
      observedAt: at(i + 1),
      receivedAt: at(i + 1),
      usable: true,
      success: i !== 1 && i !== 4,
      durationMs: 1,
    })),
    coverage: [
      { startAt: at(0), endAt: at(11), recordedAt: at(0), state: "complete" },
    ],
    policies: [
      {
        startAt: at(0),
        endAt: at(11),
        recordedAt: at(0),
        enabled: true,
        maintenance: false,
      },
    ],
  });
}
function label(
  id: string,
  from: number,
  to: number,
  outcome: "actionable" | "noise" = "actionable",
) {
  return incidentLabelSchema.parse({
    ...scope,
    id,
    revision: 1,
    status: "reviewed",
    stream: { kind: "probe", id: "probe" },
    origin: "incident_review",
    incidentId: `incident-${id}`,
    outcome,
    startedAt: at(from),
    endedAt: at(to),
    summary: "Reviewed event",
    createdBy: "operator",
    createdAt: at(11),
    updatedAt: at(12),
    reviewedBy: "operator",
    reviewedAt: at(12),
  });
}
const decisions = (s: ReturnType<typeof fixture>) =>
  replayRuleWindows(s, null, { maxDecisions: 1440, maxSampleVisits: 1000000 })
    .decisions;
test("unmatched episodes remain unreviewed, with no precision claim", () => {
  const s = fixture(),
    report = summarizeRuleBacktest(s, decisions(s), []);
  assert.equal(report.episodes.length, 2);
  assert.equal(report.unreviewedEpisodes, 2);
  assert.equal(report.falsePositives, 0);
  assert.equal(report.precision.value, null);
  assert.equal(report.precision.wilson95, null);
});
test("only uniquely reviewed episode outcomes enter the precision denominator", () => {
  const s = fixture(),
    report = summarizeRuleBacktest(s, decisions(s), [
      label("tp", 2, 3),
      label("fp", 5, 6, "noise"),
      label("miss", 8, 9),
    ]);
  assert.equal(report.truePositives, 1);
  assert.equal(report.falsePositives, 1);
  assert.deepEqual(report.missedLabelIds, ["miss"]);
  assert.equal(report.precision.value, 0.5);
  assert.equal(report.precision.denominator, 2);
  assert.ok(report.precision.wilson95!.low < 0.5);
  assert.ok(report.precision.wilson95!.high > 0.5);
});
test("one broad label matching multiple episodes remains ambiguous", () => {
  const s = fixture(),
    report = summarizeRuleBacktest(s, decisions(s), [label("broad", 1, 7)]);
  assert.equal(report.ambiguousEpisodes, 2);
  assert.equal(report.precision.denominator, 0);
  assert.deepEqual(report.missedLabelIds, []);
});
test("conflicting reviewed labels cannot adjudicate one episode", () => {
  const s = fixture(),
    report = summarizeRuleBacktest(s, decisions(s), [
      label("positive", 2, 3),
      label("negative", 2, 3, "noise"),
    ]);
  assert.equal(report.ambiguousEpisodes, 1);
  assert.equal(report.precision.denominator, 0);
});
test("new probes without retained responses are not backtestable", () => {
  const s = fixture();
  s.samples = [];
  s.coverage = [];
  const report = summarizeRuleBacktest(s, decisions(s), [label("miss", 8, 9)]);
  assert.equal(report.status, "NOT_BACKTESTABLE");
  assert.equal(report.precision.value, null);
  assert.deepEqual(report.missedLabelIds, []);
  assert.deepEqual(report.unevaluableLabelIds, ["miss"]);
});
test("labels reviewed after the captured snapshot cannot leak into outcomes", () => {
  const s = fixture(),
    l = label("later", 2, 3);
  l.reviewedAt = at(21);
  l.updatedAt = at(21);
  assert.equal(summarizeRuleBacktest(s, decisions(s), [l]).reviewedLabels, 0);
});
test("a submillisecond label end still includes an opening at that millisecond", () => {
  const s = fixture(),
    l = label("fraction", 1, 2);
  l.endedAt = "2026-10-07T00:02:00.000001Z";
  assert.equal(summarizeRuleBacktest(s, decisions(s), [l]).truePositives, 1);
});
test("tenant substitution and missing persisted decisions are rejected", () => {
  const s = fixture(),
    l = label("other", 2, 3);
  const foreign = incidentLabelSchema.parse({ ...l, workspaceId: "other" });
  assert.throws(
    () => summarizeRuleBacktest(s, decisions(s), [foreign]),
    /scope_violation/,
  );
  assert.throws(
    () => summarizeRuleBacktest(s, decisions(s).slice(1), []),
    /every persisted/,
  );
});
