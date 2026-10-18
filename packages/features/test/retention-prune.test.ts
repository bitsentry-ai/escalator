import assert from "node:assert/strict";
import test from "node:test";
import { workspaceIdSchema } from "../src/contracts/index.js";
import {
  planReplayPrune,
  type ReplayPruneBatch,
} from "../src/application/retention/prune.js";
const scope = workspaceIdSchema.parse("workspace"),
  MiB = 1024 ** 2;
const now = "2026-10-03T00:00:00.000Z";
const settings = { days: 1, maxBytes: 2 * MiB };
const row = (id: string, observedAt: string, protectedRow = false) => ({
  workspaceId: scope,
  sourceId: "source",
  kind: "signal" as const,
  id,
  observedAt,
  bytes: MiB,
  protected: protectedRow,
});
const batch = (
  candidates: ReplayPruneBatch["candidates"],
  limit = 100,
): ReplayPruneBatch => ({
  workspaceId: scope,
  sourceId: "source",
  limit,
  candidates,
});
test("age expiry is strict at the cutoff and cannot evict a protected old record", () => {
  const result = planReplayPrune(
    settings,
    now,
    { retainedBytes: 3 * MiB, protectedBytes: MiB },
    batch([
      row("protected", "2026-10-01T00:00:00.000Z", true),
      row("old", "2026-10-01T23:59:59.999Z"),
      row("boundary", "2026-10-02T00:00:00.000Z"),
    ]),
  );
  assert.deepEqual(result.selected, [{ kind: "signal", id: "old" }]);
  assert.equal(result.budgetPressureAfterBatch, 0);
});
test("storage pressure selects the oldest eligible payload without mutating input order", () => {
  const candidates = [
    row("new", now),
    row("old", "2026-10-02T12:00:00.000Z"),
    row("middle", "2026-10-02T18:00:00.000Z"),
  ];
  const result = planReplayPrune(
    settings,
    now,
    { retainedBytes: 3 * MiB, protectedBytes: 0 },
    batch(candidates),
  );
  assert.deepEqual(result.selected, [{ kind: "signal", id: "old" }]);
  assert.equal(result.plannedBytes, MiB);
  assert.deepEqual(
    candidates.map((value) => value.id),
    ["new", "old", "middle"],
  );
});
test("a bounded batch reports remaining byte pressure instead of deleting protected payloads", () => {
  const result = planReplayPrune(
    settings,
    now,
    { retainedBytes: 5 * MiB, protectedBytes: 3 * MiB },
    batch(
      [
        row("eligible", now),
        { ...row("protected", now, true), bytes: 3 * MiB },
        row("later", now),
      ],
      1,
    ),
  );
  assert.equal(result.selected.length, 1);
  assert.equal(result.budgetPressureAfterBatch, 2 * MiB);
});
test("foreign candidates, duplicate receipts, unsafe batches and inconsistent byte snapshots fail closed", () => {
  const valid = row("id", now),
    usage = { retainedBytes: MiB, protectedBytes: 0 };
  for (const candidates of [
    [{ ...valid, workspaceId: workspaceIdSchema.parse("foreign") }],
    [{ ...valid, sourceId: "foreign" }],
    [valid, valid],
    [{ ...valid, bytes: 2 * MiB }],
    [{ ...valid, protected: true }],
  ])
    assert.throws(() =>
      planReplayPrune(settings, now, usage, batch(candidates)),
    );
  assert.throws(() =>
    planReplayPrune(settings, now, usage, batch([valid], 101)),
  );
});

test("an entirely protected budget remains over target with no selected deletions", () => {
  const result = planReplayPrune(
    settings,
    now,
    { retainedBytes: 3 * MiB, protectedBytes: 3 * MiB },
    batch([
      { ...row("protected", "2026-09-01T00:00:00.000Z", true), bytes: 3 * MiB },
    ]),
  );
  assert.deepEqual(result.selected, []);
  assert.equal(result.plannedBytes, 0);
  assert.equal(result.budgetPressureAfterBatch, MiB);
});
