import test from "node:test";
import assert from "node:assert/strict";
import { responderIdSchema, type Actor } from "../src/contracts/index.js";
import {
  InvestigationReports,
  InvestigationReportError,
  type InvestigationReportRepository,
} from "../src/application/investigation-report/reader.js";
import { investigationFixture } from "./fixtures/investigation.js";
function fixture() {
  const { claim } = investigationFixture();
  const actor: Actor = {
    workspaceId: claim.scope.workspaceId,
    responderId: responderIdSchema.parse("peer"),
    role: "viewer",
  };
  const calls: Array<{
    actor: Pick<Actor, "workspaceId" | "responderId">;
    id: string;
  }> = [];
  let snapshot: Awaited<ReturnType<InvestigationReportRepository["read"]>> = {
    scope: claim.scope,
    observedAt: "2026-10-01T01:01:00.000Z",
    row: null,
  };
  let availabilityCalls = 0;
  const repository: InvestigationReportRepository = {
    async read(value, id) {
      calls.push({ actor: value, id });
      return snapshot;
    },
  };
  const reader = new InvestigationReports(repository, () => {
    availabilityCalls++;
    return "integration_required";
  });
  return {
    actor,
    claim,
    calls,
    reader,
    setSnapshot(value: typeof snapshot) {
      snapshot = value;
    },
    availabilityCalls: () => availabilityCalls,
  };
}
test("human reads use only the trusted workspace, responder and incident ID", async () => {
  const f = fixture();
  const view = await f.reader.read(f.actor, { id: f.claim.scope.incidentId });
  assert.deepEqual(f.calls, [
    {
      actor: {
        workspaceId: f.actor.workspaceId,
        responderId: f.actor.responderId,
      },
      id: f.claim.scope.incidentId,
    },
  ]);
  assert.equal(view.run, null);
  assert.equal(view.execution, "integration_required");
});
test("a missing incident or inactive responder does not reveal execution availability", async () => {
  const f = fixture();
  f.setSnapshot(undefined);
  await assert.rejects(
    f.reader.read(f.actor, { id: f.claim.scope.incidentId }),
    (error) =>
      error instanceof InvestigationReportError && error.code === "not_found",
  );
  assert.equal(f.availabilityCalls(), 0);
});
test("request payloads cannot select organization, source, model or worker credentials", async () => {
  const f = fixture();
  for (const key of [
    "workspaceId",
    "organizationId",
    "sourceId",
    "profileId",
    "claimToken",
    "secretId",
  ])
    await assert.rejects(
      f.reader.read(f.actor, { id: f.claim.scope.incidentId, [key]: "other" }),
    );
  assert.equal(f.calls.length, 0);
});
test("a repository response from another workspace or incident is refused", async () => {
  for (const key of ["workspaceId", "incidentId"]) {
    const f = fixture();
    f.setSnapshot({
      scope: { ...f.claim.scope, [key]: "other" },
      observedAt: "2026-10-01T01:01:00.000Z",
      row: null,
    });
    await assert.rejects(
      f.reader.read(f.actor, { id: f.claim.scope.incidentId }),
      (error) =>
        error instanceof InvestigationReportError &&
        error.code === "invalid_snapshot",
    );
    assert.equal(f.availabilityCalls(), 0);
  }
});
test("malformed storage is reported through a fixed error without echoing content", async () => {
  const f = fixture();
  f.setSnapshot({
    scope: f.claim.scope,
    observedAt: "2026-10-01T01:01:00.000Z",
    row: { password: "private-value" },
  });
  await assert.rejects(
    f.reader.read(f.actor, { id: f.claim.scope.incidentId }),
    (error) =>
      error instanceof InvestigationReportError &&
      error.message === "invalid_snapshot" &&
      !String(error).includes("private-value"),
  );
});
