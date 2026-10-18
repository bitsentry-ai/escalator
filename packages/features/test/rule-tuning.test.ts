import test from "node:test";
import assert from "node:assert/strict";
import { fixture, at, label } from "./conformance/rule-backtest-fixture.js";
import {
  planRuleTuning,
  trainingRuleEvidence,
} from "../src/application/rules/tuning.js";
function month() {
  const s = fixture();
  s.snapshotAt = at(43201);
  s.lastDecisionAt = at(43200);
  return s;
}
test("temporal split is fixed before observing candidate outcomes", () => {
  const s = month(),
    a = planRuleTuning(s);
  assert.equal(a.status, "held_out");
  assert.ok(a.heldOut);
  assert.ok(
    Date.parse(a.heldOut.firstDecisionAt) -
      Date.parse(a.training.lastDecisionAt) >=
      172800000,
  );
  assert.ok(
    Date.parse(a.heldOut.lastDecisionAt) -
      Date.parse(a.heldOut.firstDecisionAt) +
      60000 >=
      172800000,
  );
  s.samples = [];
  s.complete = false;
  s.version.definition.trigger.value = 0.5;
  s.version.definition.recovery.value = 0.5;
  assert.deepEqual(planRuleTuning(s), a);
  assert.equal(planRuleTuning(fixture()).status, "insufficient_span");
});
test("held-out samples, late arrivals, unknown availability and future labels are withheld", () => {
  const s = month(),
    cutoff = planRuleTuning(s).training.lastDecisionAt;
  const before = s.samples[0]!;
  s.samples = [
    before,
    { ...before, id: "late", receivedAt: at(40000) },
    { ...before, id: "unknown", receivedAt: null },
    { ...before, id: "heldout", observedAt: at(40000), receivedAt: at(40000) },
  ];
  const old = label("old", 2, 3),
    future = {
      ...old,
      id: "future",
      reviewedAt: at(40000),
      updatedAt: at(40000),
    };
  const projected = trainingRuleEvidence(s, [old, future]);
  assert.equal(projected.cutoffAt, cutoff);
  assert.deepEqual(
    projected.samples.map((x) => x.id),
    [before.id],
  );
  assert.deepEqual(
    projected.labels.map((x) => x.id),
    [old.id],
  );
  assert.equal(projected.excludedSamples, 3);
  assert.equal(projected.coverageVerified, false);
  const originalId = before.id;
  assert.notStrictEqual(projected.samples[0], s.samples[0]);
  projected.samples[0]!.id = "changed";
  assert.equal(s.samples[0]!.id, originalId);
});
test("original receipt precision is preserved at the training boundary", () => {
  const s = month(),
    cutoff = planRuleTuning(s).training.lastDecisionAt;
  s.samples = [
    { ...s.samples[0]!, receivedAt: cutoff.replace(".000Z", ".000001Z") },
  ];
  assert.equal(trainingRuleEvidence(s, []).samples.length, 0);
});
