import test from "node:test";
import assert from "node:assert/strict";
import { incidentLabelSchema } from "../src/contracts/rule-label.js";
import { replayRuleWindows } from "../src/application/rules/replay.js";
import { summarizeRuleBacktest } from "../src/application/rules/backtest.js";
import { fixture, at, label } from "./conformance/rule-backtest-fixture.js";
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
