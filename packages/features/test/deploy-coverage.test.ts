import { coverageFixture } from "./conformance/coverage-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  deploymentCoverageBindingSchema,
  deploymentCoverageDecisionSchema,
  type Actor,
} from "../src/contracts/index.js";
import {
  evaluateDeploymentCoverage,
  type DeploymentCoverageSnapshot,
} from "../src/domain/deploy/coverage.js";
import {
  coverageDecision,
  coverageDecisionState,
} from "../src/domain/deploy/coverage-decision.js";
const now = "2026-10-05T12:00:00.000Z";
test("coverage uses another enabled responder with declared working hours and contact", () => {
  const { binding, snapshot } = coverageFixture();
  const result = evaluateDeploymentCoverage(snapshot, binding, now);
  assert.equal(result.decision, "allow");
  assert.equal(result.reason, "declared_coverage");
  assert.deepEqual(result.eligibleResponderIds, ["bob"]);
  assert.deepEqual(result.scheduleVersions, [
    { id: "peer", version: 1 },
    { id: "primary", version: 1 },
  ]);
  assert.equal(JSON.stringify(result).includes("secret-bob"), false);
  snapshot.policy!.fallbackResponderIds = [snapshot.responders[0]!.id];
  snapshot.schedules[1]!.rotations[0]!.responders = [
    snapshot.responders[0]!.id,
  ];
  assert.equal(
    evaluateDeploymentCoverage(snapshot, binding, now).decision,
    "block",
  );
});
test("missing mapping and disabled or incomplete routing block rather than assuming coverage", () => {
  const { binding, snapshot } = coverageFixture();
  assert.equal(
    evaluateDeploymentCoverage(
      snapshot,
      { ...binding, mappedDeployerId: null },
      now,
    ).reason,
    "unmapped_deployer",
  );
  snapshot.responders[0]!.enabled = false;
  assert.equal(
    evaluateDeploymentCoverage(snapshot, binding, now).reason,
    "unmapped_deployer",
  );
  snapshot.responders[0]!.enabled = true;
  snapshot.schedules = [];
  assert.equal(
    evaluateDeploymentCoverage(snapshot, binding, now).reason,
    "configuration_unavailable",
  );
  snapshot.policy = null;
  assert.equal(
    evaluateDeploymentCoverage(snapshot, binding, now).reason,
    "configuration_unavailable",
  );
  const complete = coverageFixture();
  complete.snapshot.complete = false;
  assert.equal(
    evaluateDeploymentCoverage(complete.snapshot, complete.binding, now).reason,
    "configuration_unavailable",
  );
});
test("missing hours, contacts, role and disabled responders never count as declared coverage", () => {
  for (const mutate of [
    (s: DeploymentCoverageSnapshot) => {
      s.availability = s.availability.filter((row) => row.id !== "bob");
    },
    (s: DeploymentCoverageSnapshot) => {
      s.contacts.find((row) => row.responderId === "bob")!.enabled = false;
    },
    (s: DeploymentCoverageSnapshot) => {
      s.responders.find((row) => row.id === "bob")!.enabled = false;
    },
    (s: DeploymentCoverageSnapshot) => {
      s.responders.find((row) => row.id === "bob")!.role = "viewer";
    },
  ]) {
    const { binding, snapshot } = coverageFixture();
    mutate(snapshot);
    assert.equal(
      evaluateDeploymentCoverage(snapshot, binding, now).reason,
      "no_declared_coverage",
    );
  }
});
test("working windows are half-open and repeat local times across daylight-saving fall-back", () => {
  const { binding, snapshot } = coverageFixture();
  assert.equal(
    evaluateDeploymentCoverage(snapshot, binding, "2026-10-05T08:59:59.999Z")
      .decision,
    "block",
  );
  assert.equal(
    evaluateDeploymentCoverage(snapshot, binding, "2026-10-05T09:00:00.000Z")
      .decision,
    "allow",
  );
  assert.equal(
    evaluateDeploymentCoverage(snapshot, binding, "2026-10-05T17:00:00.000Z")
      .decision,
    "block",
  );
  const hours = snapshot.availability.find((row) => row.id === "bob")!;
  hours.timeZone = "America/New_York";
  hours.windows = [{ weekdays: [7], startMinute: 60, endMinute: 120 }];
  for (const at of ["2026-11-01T05:30:00.000Z", "2026-11-01T06:30:00.000Z"])
    assert.equal(
      evaluateDeploymentCoverage(snapshot, binding, at).decision,
      "allow",
    );
  assert.equal(
    evaluateDeploymentCoverage(snapshot, binding, "2026-11-01T07:00:00.000Z")
      .decision,
    "block",
  );
  hours.windows = [{ weekdays: [7], startMinute: 120, endMinute: 180 }];
  assert.equal(
    evaluateDeploymentCoverage(snapshot, binding, "2026-03-08T07:30:00.000Z")
      .decision,
    "block",
  );
});
test("coverage fingerprints ignore row order but bind versions, scope and identity", () => {
  const { binding, snapshot } = coverageFixture();
  const initial = evaluateDeploymentCoverage(snapshot, binding, now);
  snapshot.schedules.reverse();
  snapshot.responders.reverse();
  snapshot.availability.reverse();
  snapshot.contacts.reverse();
  assert.equal(
    evaluateDeploymentCoverage(snapshot, binding, now).fingerprint,
    initial.fingerprint,
  );
  snapshot.availability[0]!.version++;
  assert.notEqual(
    evaluateDeploymentCoverage(snapshot, binding, now).fingerprint,
    initial.fingerprint,
  );
  const foreign = structuredClone(snapshot);
  foreign.contacts[0]!.workspaceId =
    deploymentCoverageBindingSchema.shape.workspaceId.parse("other");
  assert.throws(
    () => evaluateDeploymentCoverage(foreign, binding, now),
    /scope mismatch/,
  );
  snapshot.schedules.push(snapshot.schedules[0]!);
  assert.throws(
    () => evaluateDeploymentCoverage(snapshot, binding, now),
    /limit/,
  );
});
test("coverage decisions expire exactly, reject binding/version changes and re-evaluate time boundaries", () => {
  const { binding, snapshot } = coverageFixture();
  const at = "2026-10-05T16:59:00.000Z";
  const evaluation = evaluateDeploymentCoverage(snapshot, binding, at);
  const decision = coverageDecision({
    id: "decision",
    binding,
    evaluation,
    now: at,
  });
  assert.equal(
    coverageDecisionState(decision, binding, evaluation, at),
    "allow",
  );
  assert.equal(
    coverageDecisionState(
      decision,
      { ...binding, externalId: "other" },
      evaluation,
      at,
    ),
    "binding_mismatch",
  );
  assert.equal(
    coverageDecisionState(decision, binding, evaluation, decision.expiresAt),
    "expired",
  );
  assert.equal(
    coverageDecisionState(
      decision,
      binding,
      evaluation,
      "2026-10-05T16:58:59.999Z",
    ),
    "expired",
  );
  const later = evaluateDeploymentCoverage(
    snapshot,
    binding,
    "2026-10-05T17:00:00.000Z",
  );
  assert.equal(later.fingerprint, evaluation.fingerprint);
  assert.equal(
    coverageDecisionState(decision, binding, later, "2026-10-05T17:00:00.000Z"),
    "block",
  );
  snapshot.schedules[0]!.version++;
  assert.equal(
    coverageDecisionState(
      decision,
      binding,
      evaluateDeploymentCoverage(snapshot, binding, at),
      at,
    ),
    "stale",
  );
});
test("an override needs an authorized actor and reason, and cannot outlive its decision", () => {
  const { binding, snapshot } = coverageFixture();
  const at = "2026-10-05T20:00:00.000Z";
  const evaluation = evaluateDeploymentCoverage(snapshot, binding, at);
  const actor: Actor = {
    workspaceId: binding.workspaceId,
    responderId: snapshot.responders[0]!.id,
    role: "administrator",
  };
  for (const role of ["responder", "viewer"] as const)
    assert.throws(
      () =>
        coverageDecision({
          id: "decision",
          binding,
          evaluation,
          now: at,
          override: { actor: { ...actor, role }, reason: "urgent repair" },
        }),
      { code: "forbidden" },
    );
  assert.throws(
    () =>
      coverageDecision({
        id: "decision",
        binding,
        evaluation,
        now: at,
        override: { actor, reason: "  " },
      }),
    { code: "invalid_override" },
  );
  const decision = coverageDecision({
    id: "decision",
    binding,
    evaluation,
    now: at,
    override: { actor, reason: "urgent repair" },
  });
  assert.equal(
    coverageDecisionState(decision, binding, evaluation, at),
    "allow",
  );
  assert.equal(
    coverageDecisionState(decision, binding, evaluation, decision.expiresAt),
    "expired",
  );
  assert.equal(
    deploymentCoverageDecisionSchema.safeParse({
      ...decision,
      expiresAt: "2026-10-06T20:00:00.000Z",
    }).success,
    false,
  );
});

test("the mapped deployer may be outside the on-call rotation", () => {
  const { binding, snapshot } = coverageFixture();
  const carol = {
    ...snapshot.responders[0]!,
    id: deploymentCoverageBindingSchema.shape.mappedDeployerId
      .unwrap()
      .parse("carol"),
    hostUserId: "carol",
    displayName: "Carol",
  };
  snapshot.responders.push(carol);
  const result = evaluateDeploymentCoverage(
    snapshot,
    { ...binding, mappedDeployerId: carol.id },
    now,
  );
  assert.equal(result.decision, "allow");
  assert.deepEqual(result.eligibleResponderIds, ["alice", "bob"]);
});
