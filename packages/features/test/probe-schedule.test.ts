import test from "node:test";
import assert from "node:assert/strict";
import {
  nextProbeDueAt,
  probeJobId,
  probeScheduleSchema,
} from "../src/application/probes/schedule.js";
test("probe deadlines keep cadence and skip missed intervals without replaying historical requests", () => {
  const due = "2026-09-20T00:00:00.000Z";
  assert.equal(nextProbeDueAt(due, due, 60), "2026-09-20T00:01:00.000Z");
  assert.equal(
    nextProbeDueAt(due, "2026-09-20T00:00:10.000Z", 60),
    "2026-09-20T00:01:00.000Z",
  );
  assert.equal(
    nextProbeDueAt(due, "2026-09-20T00:01:00.000Z", 60),
    "2026-09-20T00:02:00.000Z",
  );
  assert.equal(
    nextProbeDueAt(due, "2026-09-21T00:00:15.000Z", 60),
    "2026-09-21T00:01:00.000Z",
  );
  for (const interval of [0, 1, 59, 60.5, 3601, NaN])
    assert.throws(() => nextProbeDueAt(due, due, interval));
});
test("probe job identity includes scope, version and scheduled slot", () => {
  const due = "2026-09-20T00:00:00.000Z";
  const id = probeJobId("a", "probe", 1, due);
  assert.equal(probeJobId("a", "probe", 1, due), id);
  assert.notEqual(probeJobId("b", "probe", 1, due), id);
  assert.notEqual(probeJobId("a", "probe", 2, due), id);
  assert.notEqual(probeJobId("a", "probe", 1, "2026-09-20T00:01:00.000Z"), id);
  assert.equal(id.length, 78);
});
test("a disabled schedule clears both the deadline and job ID", () => {
  const value = {
    workspaceId: "a",
    probeId: "probe",
    probeVersion: 1,
    jobId: null,
    dueAt: null,
  };
  assert.ok(probeScheduleSchema.safeParse(value).success);
  assert.equal(
    probeScheduleSchema.safeParse({ ...value, jobId: "job" }).success,
    false,
  );
  assert.equal(
    probeScheduleSchema.safeParse({
      ...value,
      dueAt: "2026-09-20T00:00:00.000Z",
    }).success,
    false,
  );
});
