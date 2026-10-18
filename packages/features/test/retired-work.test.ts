import test from "node:test";
import assert from "node:assert/strict";
import { workspaceIdSchema } from "../src/contracts/index.js";
import {
  retentionMaintenanceId,
  type RetentionMaintenanceState,
} from "../src/application/retention/maintenance.js";
import {
  retiredRetentionWorkIds,
  type RetiredRetentionWork,
} from "../src/application/retention/retired-work.js";
const scope = workspaceIdSchema.parse("retired-work");
const now = "2026-10-10T12:00:00.000Z";
const current: RetentionMaintenanceState = {
  workspaceId: scope,
  revision: 10,
  jobId: retentionMaintenanceId(scope, 10),
  dueAt: now,
  sourceId: null,
  after: null,
  sweepStartedAt: null,
  completedAt: null,
};
const row = (revision = 1): RetiredRetentionWork => ({
  workspaceId: scope,
  id: retentionMaintenanceId(scope, revision),
  kind: "retention.sweep",
  state: "completed",
  payload: { version: 1, revision, sourceId: null },
  completedAt: "2026-10-03T12:00:00.000Z",
  leaseToken: null,
  leaseExpiresAt: null,
});
test("retired maintenance cleanup includes only exact terminal identities past seven days", () => {
  const rows = [
    row(1),
    { ...row(2), state: "failed" },
    { ...row(3), state: "cancelled" },
  ];
  assert.deepEqual(
    retiredRetentionWorkIds(scope, current, now, rows),
    rows.map((r) => r.id),
  );
  assert.deepEqual(
    retiredRetentionWorkIds(scope, current, "2026-10-10T11:59:59.999Z", rows),
    [],
  );
});
test("current, future, live, leased, malformed and unrelated work is protected", () => {
  const changes: Partial<RetiredRetentionWork>[] = [
    { kind: "signal.process" },
    { kind: "retention.sweep.fake" },
    { state: "pending" },
    { state: "running" },
    { completedAt: null },
    { completedAt: "invalid" },
    { leaseToken: "old" },
    { leaseExpiresAt: now },
    { id: "retention.sweep:forged" },
    { payload: { version: 2, revision: 1, sourceId: null } },
    { payload: { version: 1, revision: 1, sourceId: null, extra: true } },
  ];
  for (const change of changes)
    assert.deepEqual(
      retiredRetentionWorkIds(scope, current, now, [{ ...row(), ...change }]),
      [],
    );
  assert.deepEqual(
    retiredRetentionWorkIds(scope, current, now, [row(10), row(11)]),
    [],
  );
});
test("cleanup rejects cross-tenant candidates, duplicates and unbounded batches", () => {
  assert.throws(() =>
    retiredRetentionWorkIds(scope, current, now, [
      { ...row(), workspaceId: workspaceIdSchema.parse("foreign") },
    ]),
  );
  assert.throws(() =>
    retiredRetentionWorkIds(scope, current, now, [row(), row()]),
  );
  assert.throws(() =>
    retiredRetentionWorkIds(
      scope,
      current,
      now,
      Array.from({ length: 101 }, () => row()),
    ),
  );
});
