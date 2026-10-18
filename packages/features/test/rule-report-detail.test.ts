import test from "node:test";
import assert from "node:assert/strict";
import { fixture, at } from "./conformance/rule-backtest-fixture.js";
import { ruleReportDetailInputSchema } from "../src/contracts/rule-report-detail.js";
import { projectRuleReportDetail } from "../src/application/rules/report-detail-projection.js";
test("episode pages retain firing times and uncertain outcomes without exposing a whole report", () => {
  const scope = fixture().version.definition.workspaceId;
  const input = ruleReportDetailInputSchema.parse({
    runId: "run",
    section: "episodes",
    offset: 10,
    limit: 2,
  });
  const episodes = [1, 2, 3].map((n) => ({
    startedAt: at(n),
    endedAt: null,
    outcome: "unreviewed",
    labelId: null,
  }));
  const page = projectRuleReportDetail(scope, input, {
    items: episodes,
    comparison: null,
  });
  assert.equal(page.section, "episodes");
  assert.deepEqual(page.items, episodes.slice(0, 2));
  assert.equal(page.next, 12);
  assert.equal(
    projectRuleReportDetail(scope, input, { items: episodes.slice(0, 1) }).next,
    null,
  );
  assert.throws(() =>
    projectRuleReportDetail(scope, input, {
      items: [...episodes, episodes[0]],
    }),
  );
});
test("unknown history ranges are separate from predicted incidents and missing comparison stays absent", () => {
  const scope = fixture().version.definition.workspaceId;
  const gap = {
    range: { firstDecisionAt: at(1), lastDecisionAt: at(3), decisions: 3 },
    reason: "missing",
  };
  const gaps = projectRuleReportDetail(
    scope,
    ruleReportDetailInputSchema.parse({ runId: "run", section: "gaps" }),
    { items: [gap] },
  );
  assert.deepEqual(gaps.items, [gap]);
  assert.equal(gaps.section, "gaps");
  const comparison = projectRuleReportDetail(
    scope,
    ruleReportDetailInputSchema.parse({ runId: "run", section: "comparison" }),
    { items: [], comparison: null },
  );
  assert.equal(comparison.section, "comparison");
  if (comparison.section === "comparison")
    assert.equal(comparison.comparison, null);
  for (const input of [
    { section: "SQL" },
    { section: "episodes", offset: -1 },
    { section: "episodes", limit: 26 },
  ])
    assert.throws(() =>
      ruleReportDetailInputSchema.parse({ runId: "run", ...input }),
    );
});
