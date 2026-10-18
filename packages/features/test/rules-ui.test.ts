import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RuleBacktestSummary } from "../src/ui/rules/RuleBacktestSummary.js";
import {
  ruleReplayResultSchema,
  type RuleReplayResult,
} from "../src/contracts/index.js";
import { escalatorResources } from "../src/locales/index.js";
import { fixture, at } from "./conformance/rule-backtest-fixture.js";
import { replayRuleWindows } from "../src/application/rules/replay.js";
import { summarizeRuleBacktest } from "../src/application/rules/backtest.js";
const t = (key: string) => {
  let value: unknown = escalatorResources["en-US"].escalator;
  for (const part of key.split("."))
    value = (value as Record<string, unknown>)?.[part];
  assert.equal(typeof value, "string", `Missing ${key}`);
  return value as string;
};
function result(): RuleReplayResult {
  const s = fixture(),
    rows = replayRuleWindows(s, null, {
      maxDecisions: 1440,
      maxSampleVisits: 1000000,
    });
  const r = summarizeRuleBacktest(s, rows.decisions, []);
  return ruleReplayResultSchema.parse({
    id: "run",
    workspaceId: s.version.definition.workspaceId,
    snapshotId: s.snapshotId,
    version: s.version,
    firstDecisionAt: s.firstDecisionAt,
    lastDecisionAt: s.lastDecisionAt,
    createdAt: at(20),
    updatedAt: at(21),
    decisionCount: rows.decisions.length,
    proposalSource: false,
    state: "completed",
    report: {
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
  });
}
test("unreviewed replay precision stays unknown rather than becoming zero or perfect", () => {
  const report = result();
  assert.equal(report.report!.precision.value, null);
  const html = renderToStaticMarkup(
    createElement(RuleBacktestSummary, { report, t }),
  );
  assert.ok(
    html.includes(
      `<dt>${t("rules.precision")}</dt><dd>${t("rules.unknown")}</dd>`,
    ),
  );
  for (const key of [
    "coverage",
    "unreviewed",
    "missed",
    "unevaluable",
    "reportReason",
    "reportHelp",
    "precisionDenominator",
    "precisionInterval",
    "labelCoverage",
  ])
    assert.ok(html.includes(t(`rules.${key}`)), key);
  assert.ok(!html.includes(t("rules.confirmActivation")));
});
test("failed and missing work cannot render completed backtest numbers", () => {
  for (const state of ["failed", "unknown", "queued", "reporting"] as const) {
    const report = ruleReplayResultSchema.parse({
      ...result(),
      state,
      report: null,
    });
    const html = renderToStaticMarkup(
      createElement(RuleBacktestSummary, { report, t }),
    );
    assert.ok(html.includes(t(`rules.workStates.${state}`)));
    assert.ok(!html.includes(`<dt>${t("rules.precision")}</dt>`));
    assert.ok(!html.includes(t("rules.workStates.completed")));
  }
});
