import test from "node:test";
import assert from "node:assert/strict";
import {
  ruleReplaySnapshotSchema,
  type RuleReplaySnapshot,
} from "../src/contracts/rule-replay.js";
import { replayRuleWindows } from "../src/application/rules/replay.js";
import { advanceRuleDecision } from "../src/domain/rules/advance.js";
import type { RuleEvaluationState } from "../src/contracts/rule-state.js";

const at = (minute: number) =>
  new Date(Date.parse("2026-10-06T00:00:00Z") + minute * 60000).toISOString();
const scope = {
  workspaceId: "org-a",
  serviceId: "service",
  environmentId: "prod",
};
const budget = { maxDecisions: 100, maxSampleVisits: 10000 };
function snapshot(): RuleReplaySnapshot {
  return ruleReplaySnapshotSchema.parse({
    snapshotId: "snapshot-1",
    snapshotAt: at(10),
    firstDecisionAt: at(1),
    lastDecisionAt: at(8),
    complete: true,
    version: {
      id: "rule-1",
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
        persistenceSeconds: 60,
        recoverySeconds: 60,
        cooldownSeconds: 60,
        severity: "high",
      },
    },
    samples: Array.from({ length: 8 }, (_, i) => ({
      ...scope,
      id: `sample-${i}`,
      streamId: "probe",
      kind: "probe",
      observedAt: at(i + 1),
      receivedAt: at(i + 1),
      usable: true,
      success: i >= 3 && i <= 4,
      durationMs: 10,
    })),
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
test("live and replay use identical deterministic transitions on the same retained fixture", () => {
  const input = snapshot(),
    original = structuredClone(input);
  let state: RuleEvaluationState | null = null;
  const live = input.samples.map((sample) => {
    const decision = advanceRuleDecision(input.version, state, {
      window: {
        decisionAt: sample.observedAt,
        complete: true,
        coverage: "complete",
        samples: [sample],
      },
      enabled: true,
      maintenance: false,
    });
    state = decision.state;
    return decision;
  });
  const replay = replayRuleWindows(input, null, budget);
  assert.equal(replay.status, "complete");
  assert.equal(replay.nextDecisionAt, null);
  assert.deepEqual(replay.decisions, live);
  assert.deepEqual(input, original);
  assert.deepEqual(
    live.map((row) => row.action),
    ["none", "opened", "none", "none", "recovered", "none", "opened", "none"],
  );
});
test("replay is stable across input ordering and persisted batch cursors", () => {
  const input = snapshot(),
    expected = replayRuleWindows(input, null, budget);
  input.samples.reverse();
  let part = replayRuleWindows(input, null, { ...budget, maxDecisions: 2 });
  const decisions = [...part.decisions];
  while (part.status !== "complete") {
    part = replayRuleWindows(input, JSON.parse(JSON.stringify(part.cursor)), {
      ...budget,
      maxDecisions: 2,
    });
    decisions.push(...part.decisions);
  }
  assert.deepEqual(decisions, expected.decisions);
  assert.deepEqual(part.cursor, expected.cursor);
  const repeated = replayRuleWindows(input, part.cursor, budget);
  assert.equal(repeated.status, "complete");
  assert.deepEqual(repeated.decisions, []);
});
test("late arrivals cannot establish persistence at historical decision time", () => {
  const input = snapshot();
  input.samples[0]!.receivedAt = at(4);
  const result = replayRuleWindows(input, null, budget);
  assert.equal(result.decisions[0]!.verdict!.state, "insufficient_data");
  assert.equal(result.decisions[0]!.verdict!.lateCount, 1);
  assert.equal(result.decisions[1]!.action, "none");
  assert.equal(result.decisions[2]!.action, "opened");
});
test("unknown receipt times are retrospective and never count as historical proof", () => {
  const input = snapshot();
  input.samples[0]!.receivedAt = null;
  const first = replayRuleWindows(input, null, budget).decisions[0]!;
  assert.equal(first.verdict!.reason, "retrospective_samples");
  assert.equal(first.action, "none");
});
test("future or unknown policy availability cannot be applied to past decisions", () => {
  for (const recordedAt of [at(4), null]) {
    const input = snapshot();
    input.policies[0]!.recordedAt = recordedAt;
    const result = replayRuleWindows(input, null, budget);
    assert.equal(result.decisions[0]!.verdict!.reason, "coverage_unknown");
    assert.equal(result.decisions[1]!.action, "none");
  }
});
test("missing coverage and truncated reads cannot create a healthy replay", () => {
  for (const mutate of [
    (input: RuleReplaySnapshot) => {
      input.complete = false;
    },
    (input: RuleReplaySnapshot) => {
      input.coverage = [];
    },
    (input: RuleReplaySnapshot) => {
      input.coverage[0]!.state = "gaps";
    },
    (input: RuleReplaySnapshot) => {
      input.coverage[0]!.recordedAt = null;
    },
  ]) {
    const input = snapshot();
    mutate(input);
    const result = replayRuleWindows(input, null, budget);
    assert.ok(
      result.decisions.every(
        (row) =>
          row.action === "none" && row.verdict?.state === "insufficient_data",
      ),
    );
  }
});
test("maintenance and disabled periods interrupt pending timers without retroactive openings", () => {
  for (const policy of [
    { enabled: false, maintenance: false },
    { enabled: true, maintenance: true },
  ]) {
    const input = snapshot();
    input.policies = [
      {
        startAt: at(0),
        endAt: at(2),
        recordedAt: at(0),
        enabled: true,
        maintenance: false,
      },
      { startAt: at(2), endAt: at(3), recordedAt: at(1), ...policy },
      {
        startAt: at(3),
        endAt: at(9),
        recordedAt: at(2),
        enabled: true,
        maintenance: false,
      },
    ];
    const result = replayRuleWindows(input, null, budget);
    assert.equal(result.decisions[1]!.status, "suppressed");
    assert.equal(result.decisions[2]!.action, "none");
    assert.equal(result.decisions[2]!.state.triggerSince, at(3));
  }
});
test("sample-visit and decision budgets stop before an entire decision, without partial state", () => {
  const input = snapshot();
  const batch = replayRuleWindows(input, null, {
    ...budget,
    maxSampleVisits: 1,
  });
  assert.equal(batch.status, "budget_exhausted");
  assert.equal(batch.decisions.length, 1);
  assert.equal(batch.sampleVisits, 1);
  assert.equal(batch.nextDecisionAt, at(2));
  const next = replayRuleWindows(input, batch.cursor, budget);
  assert.deepEqual(
    [...batch.decisions, ...next.decisions],
    replayRuleWindows(input, null, budget).decisions,
  );
});
test("cancellation returns a resumable cursor without executing another decision", () => {
  const input = snapshot(),
    controller = new AbortController();
  controller.abort();
  const first = replayRuleWindows(input, null, budget, controller.signal);
  assert.equal(first.status, "cancelled");
  assert.equal(first.cursor, null);
  assert.equal(first.nextDecisionAt, at(1));
  assert.deepEqual(first.decisions, []);
});
test("an oversized first window returns no partial decision when its sample budget is exhausted", () => {
  const input = snapshot();
  input.samples.push({ ...input.samples[0]!, id: "another" });
  const result = replayRuleWindows(input, null, {
    ...budget,
    maxSampleVisits: 1,
  });
  assert.equal(result.status, "budget_exhausted");
  assert.equal(result.cursor, null);
  assert.deepEqual(result.decisions, []);
  assert.equal(result.nextDecisionAt, at(1));
});
test("empty probe history remains unknown rather than inventing samples", () => {
  const input = snapshot();
  input.samples = [];
  const result = replayRuleWindows(input, null, budget);
  assert.ok(
    result.decisions.every((row) => row.verdict?.reason === "missing_samples"),
  );
});
test("overlapping or empty policy/coverage intervals fail instead of silently selecting a revision", () => {
  const input = snapshot();
  input.policies.push({ ...input.policies[0]! });
  assert.throws(() => replayRuleWindows(input, null, budget), /overlap/);
  input.policies.pop();
  input.coverage[0]!.endAt = input.coverage[0]!.startAt;
  assert.throws(() => replayRuleWindows(input, null, budget), /empty/);
});
test("a replay cursor cannot be reused for another snapshot, scope or rule revision", () => {
  const input = snapshot(),
    first = replayRuleWindows(input, null, { ...budget, maxDecisions: 1 });
  assert.ok(first.cursor);
  assert.throws(
    () =>
      replayRuleWindows(
        { ...input, snapshotId: "another" },
        first.cursor,
        budget,
      ),
    /does not belong/,
  );
  const foreign = structuredClone(first.cursor);
  foreign.state.revision++;
  assert.throws(
    () => replayRuleWindows(input, foreign, budget),
    /does not belong/,
  );
  const before = structuredClone(first.cursor);
  before.state.lastDecisionAt = at(0);
  before.state.triggerSince = null;
  assert.throws(
    () => replayRuleWindows(input, before, budget),
    /does not belong/,
  );
});
test("foreign samples fail even when outside the replay window", () => {
  const input = snapshot();
  input.samples.push({
    ...input.samples[0]!,
    workspaceId: input.version.definition.workspaceId,
    streamId: "other",
    observedAt: at(-5),
  });
  assert.throws(() => replayRuleWindows(input, null, budget), /scope mismatch/);
});
test("replay rejects unsupported bounds and future decision windows", () => {
  const input = snapshot();
  assert.throws(() =>
    replayRuleWindows(input, null, { ...budget, maxDecisions: 1441 }),
  );
  assert.throws(() =>
    replayRuleWindows({ ...input, lastDecisionAt: at(11) }, null, budget),
  );
  assert.throws(() =>
    replayRuleWindows({ ...input, firstDecisionAt: at(1.5) }, null, budget),
  );
  input.samples[0]!.receivedAt = at(11);
  assert.throws(
    () => replayRuleWindows(input, null, budget),
    /future receipts/,
  );
});
