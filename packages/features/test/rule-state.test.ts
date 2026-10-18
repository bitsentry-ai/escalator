import test from "node:test";
import assert from "node:assert/strict";
import {
  detectionRuleVersionSchema,
  ruleEvaluationStateSchema,
  type DetectionRuleVersion,
  type RuleEvaluationState,
} from "../src/contracts/rule-state.js";
import { ruleWindowSchema, type RuleWindow } from "../src/contracts/rules.js";
import { advanceRuleDecision } from "../src/domain/rules/advance.js";

const at = (minute: number) =>
  new Date(Date.parse("2026-10-06T00:00:00Z") + minute * 60000).toISOString();
const scope = {
  workspaceId: "org-a",
  serviceId: "service",
  environmentId: "prod",
};
function version(): DetectionRuleVersion {
  return detectionRuleVersionSchema.parse({
    id: "rule-one",
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
      persistenceSeconds: 120,
      recoverySeconds: 60,
      cooldownSeconds: 120,
      severity: "high",
    },
  });
}
function window(minute: number, success = false): RuleWindow {
  return ruleWindowSchema.parse({
    decisionAt: at(minute),
    complete: true,
    coverage: "complete",
    samples: [
      {
        ...scope,
        id: `sample-${minute}`,
        kind: "probe",
        streamId: "probe",
        observedAt: at(minute),
        receivedAt: at(minute),
        usable: true,
        success,
        durationMs: 10,
      },
    ],
  });
}
function step(
  v: DetectionRuleVersion,
  state: RuleEvaluationState | null,
  minute: number,
  success = false,
) {
  return advanceRuleDecision(v, state, {
    window: window(minute, success),
    enabled: true,
    maintenance: false,
  });
}
test("consecutive trigger persistence opens exactly once across persisted state round trips", () => {
  const v = version();
  let state: RuleEvaluationState | null = null;
  const actions = [];
  for (const minute of [1, 2, 3, 4, 5]) {
    const decision = step(v, state, minute);
    actions.push(decision.action);
    state = ruleEvaluationStateSchema.parse(
      JSON.parse(JSON.stringify(decision.state)),
    );
  }
  assert.deepEqual(actions, ["none", "none", "opened", "none", "none"]);
  assert.equal(state!.activeSince, at(3));
  assert.equal(state!.triggerSince, null);
});
test("a gap in scheduling restarts persistence instead of crediting unobserved decisions", () => {
  const v = version();
  const first = step(v, null, 1);
  const gap = step(v, first.state, 4);
  assert.equal(gap.action, "none");
  assert.equal(gap.state.triggerSince, at(4));
  const next = step(v, gap.state, 5);
  assert.equal(step(v, next.state, 6).action, "opened");
});
test("unknown windows break pending triggers without declaring recovery", () => {
  const v = version();
  const first = step(v, null, 1);
  const unknown = advanceRuleDecision(v, first.state, {
    window: { ...window(2), coverage: "gaps" },
    enabled: true,
    maintenance: false,
  });
  assert.equal(unknown.state.triggerSince, null);
  assert.equal(unknown.action, "none");
  assert.equal(step(v, unknown.state, 3).action, "none");
});
test("an active episode survives unknown, hold and disabled windows", () => {
  const v = version();
  v.definition.persistenceSeconds = 0;
  const active = step(v, null, 1);
  for (const input of [
    {
      window: { ...window(2), complete: false },
      enabled: true,
      maintenance: false,
    },
    { window: window(2, true), enabled: false, maintenance: false },
    { window: window(2, true), enabled: true, maintenance: true },
  ]) {
    const result = advanceRuleDecision(v, active.state, input);
    assert.equal(result.state.activeSince, at(1));
    assert.equal(result.action, "none");
    assert.equal(result.state.recoverySince, null);
  }
  v.definition.recovery = { operator: "lt", value: 0 };
  const hold = step(v, active.state, 2, true);
  assert.equal(hold.verdict!.state, "hold");
  assert.equal(hold.state.activeSince, at(1));
});
test("consecutive recovery emits the original episode and starts cooldown only once", () => {
  const v = version();
  v.definition.persistenceSeconds = 0;
  let current = step(v, null, 1);
  current = step(v, current.state, 2, true);
  assert.equal(current.action, "none");
  current = step(v, current.state, 3, true);
  assert.equal(current.action, "recovered");
  assert.equal(current.episodeStartedAt, at(1));
  assert.equal(current.state.activeSince, null);
  assert.equal(current.state.cooldownUntil, at(5));
  const blocked = step(v, current.state, 4);
  assert.equal(blocked.action, "none");
  assert.equal(blocked.state.triggerSince, null);
  assert.equal(step(v, blocked.state, 5).action, "opened");
});
test("persistence starts after cooldown expires and does not accumulate during suppression", () => {
  const v = version();
  v.definition.recoverySeconds = 0;
  let current = step(v, null, 1);
  current = step(v, current.state, 2);
  current = step(v, current.state, 3);
  assert.equal(current.action, "opened");
  current = step(v, current.state, 4, true);
  assert.equal(current.action, "recovered");
  current = step(v, current.state, 5);
  assert.equal(current.state.triggerSince, null);
  current = step(v, current.state, 6);
  assert.equal(current.state.triggerSince, at(6));
  current = step(v, current.state, 7);
  assert.equal(current.action, "none");
  assert.equal(step(v, current.state, 8).action, "opened");
});
test("unknown and missing decisions reset consecutive recovery", () => {
  const v = version();
  v.definition.persistenceSeconds = 0;
  const active = step(v, null, 1),
    candidate = step(v, active.state, 2, true);
  const gap = step(v, candidate.state, 4, true);
  assert.equal(gap.action, "none");
  assert.equal(gap.state.recoverySince, at(4));
  const unknown = advanceRuleDecision(v, gap.state, {
    window: { ...window(5), samples: [] },
    enabled: true,
    maintenance: false,
  });
  assert.equal(unknown.state.recoverySince, null);
  assert.equal(unknown.state.activeSince, at(1));
  const restart = step(v, unknown.state, 6, true);
  assert.equal(restart.action, "none");
  assert.equal(step(v, restart.state, 7, true).action, "recovered");
});
test("duplicate and older decisions cannot emit or undo incident actions", () => {
  const v = version();
  v.definition.persistenceSeconds = 0;
  const active = step(v, null, 2);
  for (const [minute, status] of [
    [2, "duplicate"],
    [1, "stale"],
  ] as const) {
    const result = step(v, active.state, minute, true);
    assert.equal(result.status, status);
    assert.equal(result.action, "none");
    assert.equal(result.verdict, null);
    assert.deepEqual(result.state, active.state);
  }
});
for (const key of ["workspaceId", "serviceId", "environmentId"] as const) {
  test(`state from a different ${key} is rejected`, () => {
    const v = version(),
      first = step(v, null, 1);
    const foreign = ruleEvaluationStateSchema.parse({
      ...first.state,
      [key]: "other",
    });
    assert.throws(() => step(v, foreign, 2), /another immutable version/);
  });
}
test("state from a different rule or revision is rejected", () => {
  const v = version(),
    first = step(v, null, 1);
  assert.throws(
    () => step(v, { ...first.state, ruleId: "another" }, 2),
    /another immutable version/,
  );
  assert.throws(
    () => step(v, { ...first.state, revision: 2 }, 2),
    /another immutable version/,
  );
});
test("zero persistence and recovery take effect on their first qualifying windows", () => {
  const v = version();
  v.definition.persistenceSeconds = 0;
  v.definition.recoverySeconds = 0;
  v.definition.cooldownSeconds = 0;
  const first = step(v, null, 1);
  assert.equal(first.action, "opened");
  const second = step(v, first.state, 2, true);
  assert.equal(second.action, "recovered");
  assert.equal(second.state.cooldownUntil, null);
  assert.equal(step(v, second.state, 3).action, "opened");
});
test("maintenance interrupts pending timers and never silently closes an episode", () => {
  const v = version(),
    first = step(v, null, 1);
  const suppressed = advanceRuleDecision(v, first.state, {
    window: window(2),
    enabled: true,
    maintenance: true,
  });
  assert.equal(suppressed.status, "suppressed");
  assert.equal(suppressed.state.triggerSince, null);
  const restart = step(v, suppressed.state, 3);
  assert.equal(restart.state.triggerSince, at(3));
  assert.equal(restart.action, "none");
});
test("state and inputs remain immutable", () => {
  const v = version(),
    first = step(v, null, 1),
    original = structuredClone({ v, first });
  step(v, first.state, 2);
  assert.deepEqual({ v, first }, original);
});
test("invalid stored combinations and unaligned timestamps are rejected", () => {
  const v = version(),
    first = step(v, null, 1);
  for (const patch of [
    { recoverySince: at(1) },
    { triggerSince: at(2) },
    { cooldownUntil: at(5) },
    { activeSince: at(1) },
  ])
    assert.equal(
      ruleEvaluationStateSchema.safeParse({ ...first.state, ...patch }).success,
      false,
    );
  assert.throws(
    () =>
      step(
        v,
        {
          ...first.state,
          lastDecisionAt: new Date(Date.parse(at(1)) + 1).toISOString(),
        },
        2,
      ),
    /not step aligned/,
  );
});
