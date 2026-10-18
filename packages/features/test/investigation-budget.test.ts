import test from "node:test";
import assert from "node:assert/strict";
import {
  InvestigationBudget,
  InvestigationBudgetError,
} from "../src/investigation/orchestration/budget.js";
import type { BudgetResource } from "../src/investigation/ports/index.js";
const limits = {
  maxDurationMs: 1000,
  maxModelCalls: 1,
  maxEvidenceReads: 2,
  maxEvidenceBytes: 1024,
  maxOutputTokens: 128,
  maxTraceEvents: 4,
};
function fixture() {
  let mono = 100;
  const controller = new AbortController();
  const clock = {
    now: () => {
      throw new Error("Wall clock must not control budgets");
    },
    monotonicMs: () => mono,
  };
  return {
    budget: new InvestigationBudget(limits, clock, controller.signal),
    clock,
    controller,
    setTime: (value: number) => {
      mono = value;
    },
  };
}
const reason = (expected: string) => (error: unknown) =>
  error instanceof InvestigationBudgetError && error.reason === expected;
test("resource charges are atomic at each configured ceiling", () => {
  const { budget } = fixture();
  for (const [resource, capacity] of [
    ["modelCalls", 1],
    ["evidenceReads", 2],
    ["evidenceBytes", 1024],
    ["outputTokens", 128],
    ["traceEvents", 4],
  ] as const) {
    assert.equal(budget.consume(resource, capacity), true);
    const before = budget.snapshot();
    assert.equal(budget.consume(resource, 1), false);
    assert.deepEqual(budget.snapshot(), before);
  }
});
test("invalid charges and property names never alter usage", () => {
  const { budget } = fixture();
  const before = budget.snapshot();
  for (const value of [
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.equal(budget.consume("evidenceBytes", value), false);
  for (const name of ["__proto__", "constructor", "elapsedMs", "other"])
    assert.equal(budget.consume(name as BudgetResource, 1), false);
  assert.deepEqual(budget.snapshot(), before);
  assert.equal(budget.consume("evidenceReads", 0), true);
});
test("duration expires on monotonic time without reading the wall clock", () => {
  const { budget, setTime } = fixture();
  setTime(350);
  assert.equal(budget.remainingMs(), 750);
  budget.checkpoint();
  setTime(1100);
  assert.equal(budget.remainingMs(), 0);
  assert.throws(() => budget.checkpoint(), reason("budget_exhausted"));
  assert.throws(
    () => budget.consume("modelCalls", 1),
    reason("budget_exhausted"),
  );
  assert.equal(budget.snapshot().modelCalls, 0);
  setTime(1150);
  assert.equal(budget.snapshot().elapsedMs, 1050);
});
test("cancellation prevents new charges and retains a readable usage snapshot", () => {
  const { budget, controller } = fixture();
  budget.consume("evidenceReads", 1);
  controller.abort();
  assert.throws(() => budget.checkpoint(), reason("cancelled"));
  assert.throws(() => budget.consume("modelCalls", 1), reason("cancelled"));
  assert.equal(budget.snapshot().evidenceReads, 1);
  assert.equal(budget.snapshot().modelCalls, 0);
});
test("clock regressions and faults fail closed without corrupting usage", () => {
  for (const bad of [150, Number.NaN, Number.POSITIVE_INFINITY]) {
    const { budget, setTime } = fixture();
    setTime(200);
    budget.checkpoint();
    setTime(bad);
    assert.throws(() => budget.checkpoint(), reason("budget_exhausted"));
    assert.equal(budget.snapshot().elapsedMs, 100);
    setTime(250);
    assert.throws(() => budget.checkpoint(), reason("budget_exhausted"));
  }
  let huge = -Number.MAX_VALUE;
  const extreme = new InvestigationBudget(
    limits,
    { now: () => new Date(), monotonicMs: () => huge },
    new AbortController().signal,
  );
  huge = Number.MAX_VALUE;
  assert.throws(() => extreme.checkpoint(), reason("budget_exhausted"));
  assert.equal(extreme.snapshot().elapsedMs, 0);
  const { budget, clock } = fixture();
  clock.monotonicMs = () => {
    throw new Error("clock failure");
  };
  assert.throws(() => budget.checkpoint(), reason("budget_exhausted"));
  assert.equal(budget.snapshot().elapsedMs, 0);
});
test("captured limits and snapshots cannot be used to increase allowances", () => {
  const original = { ...limits };
  const controller = new AbortController();
  const budget = new InvestigationBudget(
    original,
    { now: () => new Date(), monotonicMs: () => 1 },
    controller.signal,
  );
  original.maxModelCalls = 10;
  assert.equal(Object.isFrozen(budget.limits), true);
  assert.equal(budget.consume("modelCalls", 1), true);
  assert.equal(budget.consume("modelCalls", 1), false);
  const snapshot = budget.snapshot();
  snapshot.modelCalls = 0;
  assert.equal(budget.snapshot().modelCalls, 1);
});
