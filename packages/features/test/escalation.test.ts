import test from "node:test";
import { z } from "zod";
import assert from "node:assert/strict";
import {
  defaultEscalationPolicy,
  snapshotPolicy,
  escalationSteps,
  planEscalation,
} from "../src/domain/escalation/ladder.js";
import {
  escalationPolicySchema,
  type PolicySnapshot,
} from "../src/contracts/index.js";
const createdAt = "2026-09-19T00:00:00.000Z";
function policy(): PolicySnapshot {
  return defaultEscalationPolicy(
    z
      .strictObject(escalationPolicySchema.shape)
      .omit({ steps: true })
      .parse({
        id: "policy",
        workspaceId: "workspace",
        serviceId: "api",
        version: 1,
        primaryScheduleId: "primary",
        peerScheduleId: "peer",
        fallbackResponderIds: ["fallback"],
        terminal: {
          reminderIntervalMs: 900_000,
          maxReminders: 2,
          action: "notify_operator",
          notifyResponderIds: ["operator"],
        },
      }),
  );
}
const at = (minute: number) =>
  new Date(Date.parse(createdAt) + minute * 60_000).toISOString();
function decision(
  minute: number,
  recordedStepIds: string[] = [],
  state: "open" | "exhausted" | "acknowledged" | "resolved" = "open",
) {
  return planEscalation({
    policy: policy(),
    createdAt,
    now: at(minute),
    state,
    recordedStepIds,
  });
}
test("default immutable policy uses primary 0/2/7, peer 12, fallback 17", () => {
  const snapshot = policy();
  assert.deepEqual(
    snapshot.steps.map((step) => [step.offsetMs / 60_000, step.target]),
    [
      [0, "primary"],
      [2, "primary"],
      [7, "primary"],
      [12, "peer"],
      [17, "fallback"],
    ],
  );
  const editable = escalationPolicySchema.parse(snapshot);
  const saved = snapshotPolicy(editable);
  editable.steps[0]!.offsetMs = 999;
  editable.fallbackResponderIds.length = 0;
  assert.equal(saved.steps[0]!.offsetMs, 0);
  assert.equal(saved.fallbackResponderIds.length, 1);
  assert.ok(Object.isFrozen(saved.steps[0]));
  assert.equal(saved.version, 1);
});
test("restart selects only the current overdue level and skips obsolete reminders", () => {
  const result = decision(10);
  assert.equal(result.kind, "dispatch");
  if (result.kind !== "dispatch") return;
  assert.equal(result.step.id, "step-2");
  assert.equal(result.step.dueAt, at(7));
  assert.deepEqual(result.skip, ["step-0", "step-1"]);
  assert.equal(result.nextDueAt, at(12));
  assert.deepEqual(decision(10, ["step-2"]), {
    kind: "wait",
    dueAt: at(12),
    skip: ["step-0", "step-1"],
    exhausted: false,
  });
});
test("every default boundary dispatches its own level, independently of earlier delivery outcomes", () => {
  for (const [index, minute] of [0, 2, 7, 12, 17].entries()) {
    const result = decision(minute);
    assert.equal(result.kind, "dispatch");
    if (result.kind === "dispatch")
      assert.equal(result.step.id, `step-${index}`);
  }
  assert.deepEqual(decision(-1), {
    kind: "wait",
    dueAt: createdAt,
    skip: [],
    exhausted: false,
  });
});
test("exhaustion keeps the page open with bounded reminders and explicit operator notification", () => {
  const steps = escalationSteps(policy(), createdAt);
  assert.deepEqual(
    steps.slice(5).map((step) => [step.id, step.dueAt, step.target]),
    [
      ["reminder:1", at(32), "fallback"],
      ["reminder:2", at(47), "fallback"],
      ["terminal", at(62), "operator"],
    ],
  );
  const exhausted = decision(17);
  assert.equal(exhausted.exhausted, true);
  const reminder = decision(50);
  if (reminder.kind !== "dispatch") assert.fail("Expected reminder intent");
  assert.equal(reminder.step.id, "reminder:2");
  assert.equal(reminder.exhausted, true);
  const terminal = decision(80);
  if (terminal.kind !== "dispatch")
    assert.fail("Expected terminal notification intent");
  assert.equal(terminal.step.target, "operator");
  assert.equal(terminal.nextDueAt, null);
  assert.deepEqual(
    decision(
      90,
      steps.map((step) => step.id),
      "exhausted",
    ),
    { kind: "wait", dueAt: null, skip: [], exhausted: true },
  );
});
test("acknowledgement and resolution cancel all remaining intents without dispatch", () => {
  for (const state of ["acknowledged", "resolved"] as const) {
    const result = decision(90, ["step-0"], state);
    assert.equal(result.kind, "cancel");
    if (result.kind === "cancel") {
      assert.ok(result.cancel.includes("terminal"));
      assert.ok(!result.cancel.includes("step-0"));
    }
  }
});
test("malformed policy order, reserved IDs and unknown persisted progress are rejected", () => {
  const editable = escalationPolicySchema.parse(policy());
  editable.steps[1]!.offsetMs = 0;
  assert.throws(() => snapshotPolicy(editable));
  const reserved = escalationPolicySchema.parse(policy());
  reserved.steps[0]!.id = "reminder:1";
  assert.throws(() => snapshotPolicy(reserved));
  assert.throws(() => decision(1, ["from-another-policy"]));
  assert.throws(() => snapshotPolicy({ ...policy(), terminal: undefined }));
});

test("recorded progress cannot regress when the clock moves backward", () => {
  const result = decision(10, ["step-3"]);
  assert.deepEqual(result, {
    kind: "wait",
    dueAt: at(17),
    skip: ["step-0", "step-1", "step-2"],
    exhausted: false,
  });
});
