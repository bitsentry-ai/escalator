import test from "node:test";
import assert from "node:assert/strict";
import { fixture, at } from "./conformance/rule-backtest-fixture.js";
import { ruleReplaySnapshotSchema } from "../src/contracts/rule-replay.js";
import { workspaceIdSchema } from "../src/contracts/identity.js";
import { ruleBacktestReportSchema } from "../src/contracts/rule-backtest.js";
import { compareRecordedRules } from "../src/application/rules/compare.js";
import {
  encodeRuleReplayData,
  decodeRuleReplaySnapshot,
} from "../src/application/rules/replay-storage-codec.js";
import { summarizeRuleBacktest } from "../src/application/rules/backtest.js";
import { replayRuleWindows } from "../src/application/rules/replay.js";
import {
  encodeRuleBacktest,
  decodeRuleBacktest,
} from "../src/application/rules/backtest-storage.js";
import { ruleBacktestRecordSchema } from "../src/contracts/backtest-record.js";
const candidate = {
  episodes: [],
  coverage: {
    totalDecisions: 10,
    evaluatedDecisions: 10,
    suppressedDecisions: 0,
    unknownDecisions: 0,
    fraction: 1,
  },
};
function retained() {
  const s = fixture(),
    d = s.version.definition;
  return ruleReplaySnapshotSchema.parse({
    ...s,
    samples: [],
    coverage: [],
    policies: [],
    retained: {
      measurementHash: "a".repeat(64),
      policyFacts: [],
      policyComplete: true,
      history: {
        workspaceId: d.workspaceId,
        serviceId: d.serviceId,
        environmentId: d.environmentId,
        kind: d.selector.kind,
        streamId: d.selector.streamId,
        snapshotAt: s.snapshotAt,
        startAt: at(0),
        endAt: at(10),
        visibleAt: s.snapshotAt,
        complete: true,
        configurations: [],
        receipts: s.samples.map((sample) => ({ version: 1, sample })),
      },
      baselines: {
        basis: "recorded_rule_decisions",
        visibleAt: s.snapshotAt,
        firstDecisionAt: s.firstDecisionAt,
        lastDecisionAt: s.lastDecisionAt,
        complete: true,
        legacyUnknown: false,
        groups: [
          {
            version: { ...s.version, id: "existing" },
            generation: 1,
            mode: "active",
            decisions: 10,
            evaluated: 10,
            suppressed: 0,
            unknown: 0,
            opened: 2,
            recovered: 2,
            firstObservedDecisionAt: at(1),
            lastObservedDecisionAt: at(10),
          },
        ],
      },
    },
  });
}
test("comparison keeps recorded active and shadow openings separate", () => {
  const s = retained(),
    capture = s.retained!.baselines!;
  capture.groups.push({
    ...capture.groups[0]!,
    generation: 2,
    mode: "shadow",
    opened: 1,
  });
  const c = compareRecordedRules(s, candidate);
  assert.equal(c.status, "available");
  assert.deepEqual(
    c.groups.map((g) => [g.observation.mode, g.observation.opened]),
    [
      ["active", 2],
      ["shadow", 1],
    ],
  );
  assert.equal(c.groups[0]!.expectedDecisions, 10);
});
test("missing or legacy decisions cannot become a complete negative comparison", () => {
  const s = retained(),
    capture = s.retained!.baselines!;
  capture.legacyUnknown = true;
  assert.equal(compareRecordedRules(s, candidate).status, "partial");
  capture.legacyUnknown = false;
  capture.groups[0]!.decisions = 8;
  capture.groups[0]!.evaluated = 8;
  capture.groups[0]!.lastObservedDecisionAt = at(8);
  const c = compareRecordedRules(s, candidate);
  assert.equal(c.status, "partial");
  assert.equal(c.groups[0]!.missingDecisions, 2);
  assert.equal(c.groups[0]!.coverage, 0.8);
  assert.equal(
    compareRecordedRules(fixture(), candidate).status,
    "no_recorded_comparison",
  );
});
test("duplicate groups, future captures and foreign scope are rejected", () => {
  const s = retained(),
    capture = s.retained!.baselines!;
  capture.groups.push(capture.groups[0]!);
  assert.throws(() => compareRecordedRules(s, candidate), /Duplicate/);
  capture.groups.pop();
  capture.visibleAt = at(21);
  assert.throws(() => compareRecordedRules(s, candidate), /range/);
  capture.visibleAt = s.snapshotAt;
  capture.groups[0]!.version.definition.workspaceId =
    workspaceIdSchema.parse("other");
  assert.equal(ruleReplaySnapshotSchema.safeParse(s).success, false);
  assert.throws(() => compareRecordedRules(s, candidate), /scope_violation/);
});
test("snapshot and report codecs restore nested baseline tenant bindings", () => {
  const s = retained(),
    scope = s.version.definition.workspaceId;
  const input = { workspaceId: scope, inputHash: "a".repeat(64), snapshot: s };
  const encoded = encodeRuleReplayData(scope, "snapshot", input);
  assert.equal(encoded.includes('"workspaceId"'), false);
  assert.deepEqual(decodeRuleReplaySnapshot(scope, JSON.parse(encoded)), input);
  const decisions = replayRuleWindows(s, null, {
    maxDecisions: 60,
    maxSampleVisits: 100000,
  }).decisions;
  const report = summarizeRuleBacktest(s, decisions, []),
    record = ruleBacktestRecordSchema.parse({
      workspaceId: scope,
      runId: "run",
      snapshotId: s.snapshotId,
      inputHash: input.inputHash,
      labelHash: "b".repeat(64),
      createdAt: at(30),
      report,
    });
  const stored = encodeRuleBacktest(scope, record);
  assert.equal(stored.includes('"workspaceId"'), false);
  assert.deepEqual(decodeRuleBacktest(scope, JSON.parse(stored)), record);
  const old = JSON.parse(JSON.stringify(report));
  delete old.comparison;
  assert.equal(ruleBacktestReportSchema.parse(old).comparison, null);
});
