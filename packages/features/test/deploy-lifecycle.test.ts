import test from "node:test";
import assert from "node:assert/strict";
import {
  deploymentSchema,
  deploymentStartInputSchema,
  deploymentFinishInputSchema,
  deploymentWatchVerdictSchema,
  workspaceIdSchema,
  serviceIdSchema,
  environmentIdSchema,
  responderIdSchema,
  type Deployment,
  type DeploymentOutcome,
} from "../src/contracts/index.js";
import {
  startDeployment,
  finishDeployment,
  timeoutDeployment,
  type DeploymentTransition,
  type DeploymentStartContext,
} from "../src/domain/deploy/lifecycle.js";

const startAt = "2026-10-04T00:00:00.000Z";
const finishAt = "2026-10-04T00:05:00.000Z";
const timeoutAt = "2026-10-04T00:10:00.000Z";
const lateAt = "2026-10-04T00:12:00.000Z";
const context: DeploymentStartContext = {
  id: "deployment-1",
  workspaceId: workspaceIdSchema.parse("org-1"),
  serviceId: serviceIdSchema.parse("api"),
  environmentId: environmentIdSchema.parse("production"),
  tokenId: "grant-1",
  mappedDeployerId: null,
  timeoutSeconds: 600,
};
const start = deploymentStartInputSchema.parse({
  version: 1,
  source: "github-actions",
  externalId: "run-12:attempt-1",
  environmentId: context.environmentId,
  actor: "untrusted-ci-actor",
  commit: "abc123",
  artifact: null,
  occurredAt: startAt,
});
const finish = deploymentFinishInputSchema.parse({
  version: 1,
  source: start.source,
  externalId: start.externalId,
  environmentId: context.environmentId,
  actor: "untrusted-ci-actor",
  occurredAt: finishAt,
  outcome: "SUCCEEDED",
});
function changed(result: DeploymentTransition): Deployment {
  assert.equal(result.state, "changed");
  if (result.state !== "changed") throw new Error("Expected a change");
  return result.deployment;
}
function started() {
  return changed(startDeployment(undefined, start, context, startAt));
}
test("start snapshots trusted mapping and deadline, never the declared actor", () => {
  const value = started();
  assert.equal(value.mappedDeployerId, null);
  assert.equal(value.actor, start.actor);
  assert.equal(value.tokenId, "grant-1");
  assert.equal(value.timeoutAt, timeoutAt);
  assert.equal(value.status, "STARTED");
  assert.equal(value.revision, 1);
  const mapped = changed(
    startDeployment(
      undefined,
      start,
      {
        ...context,
        mappedDeployerId: responderIdSchema.parse("engineer-1"),
      },
      startAt,
    ),
  );
  assert.equal(mapped.mappedDeployerId, "engineer-1");
  assert.equal("watchVerdict" in value, false);
  assert.equal(
    deploymentWatchVerdictSchema.parse("INSUFFICIENT_DATA"),
    "INSUFFICIENT_DATA",
  );
});
for (const outcome of [
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
] as DeploymentOutcome[]) {
  test(`STARTED -> ${outcome} is terminal and preserves start metadata`, () => {
    const initial = started();
    const snapshot = structuredClone(initial);
    const input = { ...finish, outcome };
    const done = changed(finishDeployment(initial, input, finishAt));
    assert.deepEqual(initial, snapshot);
    assert.equal(done.status, outcome);
    assert.equal(done.finish?.outcome, outcome);
    assert.equal(done.revision, 2);
    assert.equal(done.startedAt, initial.startedAt);
    assert.equal(done.timedOutAt, null);
    assert.deepEqual(finishDeployment(done, input, lateAt), {
      state: "unchanged",
      reason: "duplicate",
    });
    assert.deepEqual(timeoutDeployment(done, lateAt), {
      state: "unchanged",
      reason: "terminal",
    });
  });
}
test("replayed start remains idempotent after finish and grant rotation", () => {
  const done = changed(finishDeployment(started(), finish, finishAt));
  const rotated = {
    ...context,
    tokenId: "grant-2",
    timeoutSeconds: 3600,
    mappedDeployerId: responderIdSchema.parse("different-engineer"),
  };
  assert.deepEqual(startDeployment(done, start, rotated, lateAt), {
    state: "unchanged",
    reason: "duplicate",
  });
  assert.equal(done.tokenId, "grant-1");
  assert.equal(done.mappedDeployerId, null);
  assert.equal(done.timeoutAt, timeoutAt);
  for (const replacement of [
    { actor: "other" },
    { commit: "other" },
    { artifact: "other" },
    { occurredAt: finishAt },
  ])
    assert.deepEqual(
      startDeployment(done, { ...start, ...replacement }, context, lateAt),
      { state: "rejected", reason: "conflict" },
    );
});
test("deadline waits until due; late finish records outcome without erasing timeout", () => {
  const initial = started();
  assert.deepEqual(timeoutDeployment(initial, "2026-10-04T00:09:59.999Z"), {
    state: "wait",
    dueAt: timeoutAt,
  });
  const timedOut = changed(timeoutDeployment(initial, timeoutAt));
  assert.equal(timedOut.status, "TIMED_OUT");
  assert.equal(timedOut.timedOutAt, timeoutAt);
  const snapshot = structuredClone(timedOut);
  const late = changed(finishDeployment(timedOut, finish, lateAt));
  assert.deepEqual(timedOut, snapshot);
  assert.equal(late.status, "TIMED_OUT");
  assert.equal(late.timedOutAt, timeoutAt);
  assert.equal(late.finish?.occurredAt, finishAt);
  assert.equal(late.finish?.receivedAt, lateAt);
  assert.equal(late.finish?.outcome, "SUCCEEDED");
  assert.equal(late.revision, 3);
  assert.deepEqual(timeoutDeployment(late, lateAt), {
    state: "unchanged",
    reason: "terminal",
  });
  assert.deepEqual(finishDeployment(late, finish, lateAt), {
    state: "unchanged",
    reason: "duplicate",
  });
});
test("serialized finish/timeout race is stable across persisted replay", () => {
  const initial = started();
  const finishFirst = changed(finishDeployment(initial, finish, timeoutAt));
  assert.deepEqual(timeoutDeployment(finishFirst, timeoutAt), {
    state: "unchanged",
    reason: "terminal",
  });
  const timeoutFirst = changed(timeoutDeployment(initial, timeoutAt));
  const restored = deploymentSchema.parse(
    JSON.parse(JSON.stringify(timeoutFirst)),
  );
  const decision = finishDeployment(restored, finish, lateAt);
  assert.deepEqual(decision, finishDeployment(timeoutFirst, finish, lateAt));
  assert.equal(changed(decision).status, "TIMED_OUT");
  assert.equal(changed(decision).finish?.outcome, finishFirst.finish?.outcome);
});
test("finish before start is explicit; conflicting terminal events never replace history", () => {
  assert.deepEqual(finishDeployment(undefined, finish, finishAt), {
    state: "rejected",
    reason: "missing_start",
  });
  for (const initial of [
    started(),
    changed(timeoutDeployment(started(), timeoutAt)),
  ]) {
    const done = changed(finishDeployment(initial, finish, lateAt));
    for (const change of [
      { outcome: "FAILED" as const },
      { actor: "other" },
      { occurredAt: timeoutAt },
    ])
      assert.deepEqual(
        finishDeployment(done, { ...finish, ...change }, lateAt),
        { state: "rejected", reason: "conflict" },
      );
  }
});
test("scope and natural identity mismatches never become duplicates", () => {
  const current = started();
  for (const change of [
    { workspaceId: workspaceIdSchema.parse("foreign") },
    { serviceId: serviceIdSchema.parse("foreign") },
    { environmentId: environmentIdSchema.parse("foreign") },
  ])
    assert.deepEqual(
      startDeployment(current, start, { ...context, ...change }, finishAt),
      { state: "rejected", reason: "scope" },
    );
  assert.deepEqual(
    startDeployment(
      undefined,
      { ...start, environmentId: environmentIdSchema.parse("foreign") },
      context,
      startAt,
    ),
    { state: "rejected", reason: "scope" },
  );
  assert.deepEqual(
    startDeployment(current, start, { ...context, id: "different" }, finishAt),
    { state: "rejected", reason: "identity" },
  );
  for (const change of [{ source: "other" }, { externalId: "other" }]) {
    assert.deepEqual(
      startDeployment(current, { ...start, ...change }, context, finishAt),
      { state: "rejected", reason: "identity" },
    );
    assert.deepEqual(
      finishDeployment(current, { ...finish, ...change }, finishAt),
      { state: "rejected", reason: "identity" },
    );
  }
  assert.deepEqual(
    finishDeployment(
      current,
      { ...finish, environmentId: environmentIdSchema.parse("foreign") },
      finishAt,
    ),
    { state: "rejected", reason: "scope" },
  );
});
test("chronology rejects future and pre-start events; delayed start stays overdue", () => {
  assert.deepEqual(
    startDeployment(
      undefined,
      { ...start, occurredAt: finishAt },
      context,
      startAt,
    ),
    { state: "rejected", reason: "chronology" },
  );
  const current = started();
  for (const occurredAt of ["2026-10-03T23:59:59.999Z", lateAt])
    assert.deepEqual(
      finishDeployment(current, { ...finish, occurredAt }, finishAt),
      { state: "rejected", reason: "chronology" },
    );
  const delayed = changed(startDeployment(undefined, start, context, lateAt));
  assert.equal(delayed.timeoutAt, timeoutAt);
  assert.equal(changed(timeoutDeployment(delayed, lateAt)).status, "TIMED_OUT");
  assert.deepEqual(timeoutDeployment(delayed, timeoutAt), {
    state: "rejected",
    reason: "chronology",
  });
  assert.deepEqual(finishDeployment(delayed, finish, finishAt), {
    state: "rejected",
    reason: "chronology",
  });
});
test("strict machine contracts reject tenant/mapping/deadline injection and invalid text", () => {
  for (const field of [
    "workspaceId",
    "serviceId",
    "mappedDeployerId",
    "tokenId",
    "timeoutSeconds",
    "status",
  ])
    assert.equal(
      deploymentStartInputSchema.safeParse({ ...start, [field]: "forged" })
        .success,
      false,
    );
  for (const change of [
    { version: 2 },
    { commit: null, artifact: null },
    { actor: "" },
    { source: "bad\nsource" },
    { externalId: "x".repeat(257) },
    { artifact: "\ud800" },
    { occurredAt: "not-a-date" },
  ])
    assert.equal(
      deploymentStartInputSchema.safeParse({ ...start, ...change }).success,
      false,
    );
  assert.equal(
    deploymentFinishInputSchema.safeParse({ ...finish, outcome: "TIMED_OUT" })
      .success,
    false,
  );
  assert.equal(
    deploymentFinishInputSchema.safeParse({
      ...finish,
      mappedDeployerId: "forged",
    }).success,
    false,
  );
  assert.equal(
    deploymentStartInputSchema.parse({
      ...start,
      occurredAt: "2026-10-04T00:00:00Z",
    }).occurredAt,
    startAt,
  );
  assert.deepEqual(
    startDeployment(
      started(),
      { ...start, occurredAt: "2026-10-04T00:00:00Z" },
      context,
      finishAt,
    ),
    { state: "unchanged", reason: "duplicate" },
  );
});
test("persisted records cannot express contradictory status or chronology", () => {
  const value = started();
  for (const patch of [
    { status: "SUCCEEDED" },
    { status: "TIMED_OUT" },
    { timedOutAt: timeoutAt },
    { timeoutAt: startAt },
    { acceptedAt: "2026-10-03T23:59:59Z" },
    { updatedAt: "2026-10-03T23:59:59Z" },
    { revision: 0 },
    { commit: null, artifact: null },
  ])
    assert.equal(
      deploymentSchema.safeParse({ ...value, ...patch }).success,
      false,
    );
  const late = changed(
    finishDeployment(
      changed(timeoutDeployment(value, timeoutAt)),
      finish,
      lateAt,
    ),
  );
  assert.equal(
    deploymentSchema.safeParse({
      ...late,
      finish: { ...late.finish, receivedAt: finishAt },
    }).success,
    false,
  );
  assert.throws(
    () =>
      finishDeployment(
        { ...value, revision: Number.MAX_SAFE_INTEGER },
        finish,
        finishAt,
      ),
    /revision exhausted/,
  );
});
