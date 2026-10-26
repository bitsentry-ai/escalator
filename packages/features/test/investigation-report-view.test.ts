import test from "node:test";
import assert from "node:assert/strict";
import { investigationFixture } from "./fixtures/investigation.js";
import { projectInvestigationView } from "../src/application/investigation-report/project.js";
function fixture() {
  const { claim, result } = investigationFixture();
  const now = "2026-10-01T01:01:00.000Z";
  const row = {
    id: claim.id,
    scope: claim.scope,
    state: "completed",
    attempts: 1,
    createdAt: result.report.startedAt,
    updatedAt: result.report.finishedAt,
    leaseExpiresAt: null as string | null,
    destination: result.report.destination,
    report: result.report as unknown,
    evidence: result.evidence as unknown[],
  };
  return {
    claim,
    result,
    row,
    now,
    read: () => projectInvestigationView(claim.scope, "configured", now, row),
  };
}
test("human view keeps the persisted report and exact redacted citations", () => {
  const f = fixture();
  const view = f.read();
  assert.equal(view.run?.state, "reported");
  assert.deepEqual(view.run?.report, f.result.report);
  assert.deepEqual(view.run?.evidence, f.result.evidence);
  assert.deepEqual(view.run?.missingEvidenceIds, []);
});
test("absent retained snapshots stay explicit without discarding the report", () => {
  const f = fixture();
  f.row.evidence = [];
  const view = f.read();
  assert.equal(view.run?.state, "reported");
  assert.deepEqual(view.run?.missingEvidenceIds, ["evidence_a"]);
  assert.deepEqual(view.run?.report, f.result.report);
});
test("no retained run does not fabricate success or assert worker health", () => {
  const f = fixture();
  for (const execution of [
    "configured",
    "disabled",
    "integration_required",
  ] as const) {
    const view = projectInvestigationView(
      f.claim.scope,
      execution,
      f.now,
      null,
    );
    assert.equal(view.run, null);
    assert.equal(view.execution, execution);
  }
});
test("expired running work awaits reclaim even exactly at lease expiry", () => {
  const f = fixture();
  f.row.state = "running";
  f.row.report = null;
  f.row.evidence = [];
  f.row.leaseExpiresAt = f.now;
  assert.equal(f.read().run?.state, "awaiting_reclaim");
  f.row.leaseExpiresAt = "2026-10-01T01:01:00.001Z";
  assert.equal(f.read().run?.state, "running");
  f.row.leaseExpiresAt = null;
  assert.throws(f.read);
});
test("completed work without a retained report is not shown as success", () => {
  const f = fixture();
  f.row.report = null;
  f.row.evidence = [];
  assert.equal(f.read().run?.state, "report_unavailable");
  f.row.state = "failed";
  assert.equal(f.read().run?.state, "failed");
  f.row.state = "pending";
  assert.equal(f.read().run?.state, "queued");
});
test("human read projection rejects cross-scope rows, reports and snapshots", () => {
  for (const axis of [
    "workspaceId",
    "serviceId",
    "environmentId",
    "incidentId",
  ]) {
    for (const target of ["row", "report", "evidence"]) {
      const f = fixture();
      if (target === "row") f.row.scope = { ...f.row.scope, [axis]: "other" };
      else if (target === "report")
        f.row.report = {
          ...f.result.report,
          scope: { ...f.claim.scope, [axis]: "other" },
        };
      else if (target === "evidence")
        f.row.evidence = [
          {
            ...f.result.evidence[0],
            scope: { ...f.claim.scope, [axis]: "other" },
          },
        ];
      assert.throws(f.read);
    }
  }
});
test("a stored snapshot must match the exact retained reference once", () => {
  const f = fixture();
  f.row.evidence = [...f.result.evidence, ...f.result.evidence];
  assert.throws(f.read);
  f.row.evidence = [
    {
      ...f.result.evidence[0],
      reference: { ...f.result.evidence[0].reference, receivedAt: f.now },
    },
  ];
  assert.throws(f.read);
  f.row.evidence = [
    {
      ...f.result.evidence[0],
      reference: { ...f.result.evidence[0].reference, id: "unlisted" },
    },
  ];
  assert.throws(f.read);
});
test("job and report must agree before the view is returned", () => {
  const f = fixture();
  f.row.state = "pending";
  assert.throws(f.read);
  f.row.state = "completed";
  f.row.report = { ...f.result.report, id: "other" };
  assert.throws(f.read);
  f.row.report = f.result.report;
  f.row.destination = { ...f.result.report.destination!, model: "different" };
  assert.throws(f.read);
});
test("the projection does not accept raw job payload or secret selectors", () => {
  const f = fixture();
  for (const extra of [
    "claimToken",
    "payload",
    "configuration",
    "secretId",
    "lastError",
  ])
    assert.throws(() =>
      projectInvestigationView(f.claim.scope, "configured", f.now, {
        ...f.row,
        [extra]: "private",
      }),
    );
});

test("cancelled persisted work is not reported as a failure or success", () => {
  const f = fixture();
  f.row.state = "cancelled";
  f.row.report = null;
  f.row.evidence = [];
  assert.equal(f.read().run?.state, "cancelled");
});
