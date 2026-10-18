import test from "node:test";
import assert from "node:assert/strict";
import {
  detectionRuleSchema,
  ruleSampleSchema,
  type RuleSample,
} from "../src/contracts/rules.js";
import { ruleReplaySnapshotSchema } from "../src/contracts/rule-replay.js";
import type { RuleEvaluationState } from "../src/contracts/rule-state.js";
import { evaluateRuleWindow } from "../src/domain/rules/evaluate.js";
import { advanceRuleDecision } from "../src/domain/rules/advance.js";
import { replayRuleWindows } from "../src/application/rules/replay.js";
const at = (minute: number) =>
  new Date(Date.parse("2026-10-06T00:00:00Z") + minute * 60000).toISOString();
const scope = { workspaceId: "org", serviceId: "api", environmentId: "prod" };
const rule = () =>
  detectionRuleSchema.parse({
    languageVersion: 1,
    ...scope,
    selector: { kind: "probe", streamId: "probe", field: "failure" },
    aggregation: "maximum",
    windowSeconds: 60,
    stepSeconds: 60,
    minimumSamples: 1,
    collectionDelaySeconds: 60,
    trigger: { operator: "gte", value: 1 },
    recovery: { operator: "lt", value: 1 },
    persistenceSeconds: 0,
    recoverySeconds: 0,
    cooldownSeconds: 0,
    severity: "high",
  });
function sample(index = 1): RuleSample {
  return ruleSampleSchema.parse({
    ...scope,
    id: `sample-${index}`,
    kind: "probe",
    streamId: "probe",
    slotAt: at(index + 0.2),
    observedAt: at(index + 0.25),
    receivedAt: at(index + 0.3),
    usable: true,
    success: index >= 3,
    durationMs: 3000,
  });
}
function window(samples: RuleSample[], decisionAt = at(3)) {
  return { decisionAt, complete: true, coverage: "complete" as const, samples };
}
test("scheduled probe bins retain real observation/receipt timestamps", () => {
  const input = sample(),
    original = structuredClone(input);
  const result = evaluateRuleWindow(rule(), window([input]));
  assert.equal(result.state, "trigger");
  assert.equal(result.sampleCount, 1);
  assert.deepEqual(input, original);
  assert.equal(
    evaluateRuleWindow(
      { ...rule(), collectionDelaySeconds: 0 },
      window([input]),
    ).reason,
    "missing_samples",
  );
});
test("metric collection delay allows ordinary delivery without granting future knowledge", () => {
  const definition = detectionRuleSchema.parse({
    ...rule(),
    selector: {
      kind: "metric",
      streamId: "metric",
      field: "error_rate",
      minimumRequests: 100,
    },
    trigger: { operator: "gte", value: 0.05 },
    recovery: { operator: "lt", value: 0.03 },
  });
  const input = ruleSampleSchema.parse({
    ...scope,
    id: "m",
    kind: "metric",
    streamId: "metric",
    slotAt: at(1),
    observedAt: at(1),
    receivedAt: at(1.2),
    usable: true,
    requests: 100,
    errors: 10,
  });
  assert.equal(
    evaluateRuleWindow(definition, window([input], at(2))).state,
    "trigger",
  );
  const late = evaluateRuleWindow(
    definition,
    window([{ ...input, receivedAt: at(2.1) }], at(2)),
  );
  assert.equal(late.state, "insufficient_data");
  assert.equal(late.lateCount, 1);
});
test("missing slot provenance and impossible chronology remain unknown", () => {
  const input = sample();
  assert.equal(input.kind, "probe");
  if (input.kind !== "probe") throw new Error("fixture");
  // Place the legacy observation within this decision's delayed lookback.
  assert.equal(
    evaluateRuleWindow(rule(), window([{ ...input, slotAt: null }])).reason,
    "retrospective_samples",
  );
  assert.equal(
    evaluateRuleWindow(rule(), window([{ ...input, slotAt: at(1.4) }])).reason,
    "invalid_input",
  );
  assert.equal(
    evaluateRuleWindow(rule(), window([{ ...input, receivedAt: at(1.22) }]))
      .reason,
    "invalid_input",
  );
  const { slotAt, ...legacy } = input;
  void slotAt;
  assert.equal(
    evaluateRuleWindow(rule(), window([legacy])).reason,
    "unaligned_window",
  );
});
test("duplicate receipts in one scheduled bin cannot impersonate complete coverage", () => {
  const first = sample();
  assert.equal(first.kind, "probe");
  if (first.kind !== "probe") throw new Error("fixture");
  const duplicate = {
    ...first,
    id: "duplicate",
    slotAt: at(1.3),
    observedAt: at(1.35),
    receivedAt: at(1.4),
  };
  assert.equal(
    evaluateRuleWindow(rule(), window([first, duplicate])).reason,
    "conflicting_samples",
  );
  assert.equal(
    evaluateRuleWindow(rule(), { ...window([first]), coverage: "gaps" }).reason,
    "coverage_gaps",
  );
});
test("collection delay is bounded and versioned with whole-step semantics", () => {
  for (const delay of [-1, 1, 61, 86460, Infinity])
    assert.equal(
      detectionRuleSchema.safeParse({
        ...rule(),
        collectionDelaySeconds: delay,
      }).success,
      false,
    );
  assert.equal(
    detectionRuleSchema.safeParse({ ...rule(), collectionDelaySeconds: 0 })
      .success,
    true,
  );
  const { collectionDelaySeconds, ...legacy } = rule();
  void collectionDelaySeconds;
  assert.equal(
    detectionRuleSchema.parse(legacy).collectionDelaySeconds,
    undefined,
  );
});
function snapshot() {
  return ruleReplaySnapshotSchema.parse({
    snapshotId: "capture",
    snapshotAt: at(10),
    version: { id: "rule", revision: 1, definition: rule() },
    firstDecisionAt: at(3),
    lastDecisionAt: at(6),
    complete: true,
    samples: [1, 2, 3, 4].map(sample),
    coverage: [
      { startAt: at(0), endAt: at(9), recordedAt: at(0), state: "complete" },
    ],
    policies: [
      {
        startAt: at(0),
        endAt: at(9),
        recordedAt: at(0),
        enabled: true,
        maintenance: false,
      },
    ],
  });
}
test("live and replay agree for off-grid probes, realistic receipt delay and recovery", () => {
  const input = snapshot(),
    original = structuredClone(input);
  let state: RuleEvaluationState | null = null;
  const live = [3, 4, 5, 6].map((minute) => {
    const value = advanceRuleDecision(input.version, state, {
      window: window(input.samples, at(minute)),
      enabled: true,
      maintenance: false,
    });
    state = value.state;
    return value;
  });
  const replay = replayRuleWindows(input, null, {
    maxDecisions: 10,
    maxSampleVisits: 100,
  });
  assert.deepEqual(replay.decisions, live);
  assert.deepEqual(
    live.map((row) => row.action),
    ["opened", "none", "recovered", "none"],
  );
  assert.deepEqual(input, original);
  const first = replayRuleWindows(input, null, {
    maxDecisions: 1,
    maxSampleVisits: 100,
  });
  const rest = replayRuleWindows(input, first.cursor, {
    maxDecisions: 10,
    maxSampleVisits: 100,
  });
  assert.deepEqual([...first.decisions, ...rest.decisions], live);
});
test("replay never admits a late receipt at an earlier simulated decision", () => {
  const input = snapshot();
  input.samples[0]!.receivedAt = at(3.5);
  const result = replayRuleWindows(input, null, {
    maxDecisions: 10,
    maxSampleVisits: 100,
  });
  assert.equal(result.decisions[0]!.action, "none");
  assert.equal(result.decisions[0]!.verdict?.lateCount, 1);
  assert.equal(result.decisions[1]!.action, "opened");
});
