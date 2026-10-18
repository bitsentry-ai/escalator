import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultReplayRetention,
  replayRetentionSettingsSchema,
  updateReplayRetentionSchema,
} from "../src/contracts/index.js";
import { retentionTarget } from "../src/application/retention/policy.js";
const MiB = 1024 ** 2;
const empty = { retainedBytes: 0, protectedBytes: 0 };
test("default replay retention uses thirty elapsed UTC days, including across DST", () => {
  const target = retentionTarget(
    defaultReplayRetention,
    "2026-04-01T00:00:00.123Z",
    empty,
  );
  assert.equal(target.cutoffAt, "2026-03-02T00:00:00.123Z");
  assert.equal(target.overBudgetBytes, 0);
});
test("storage pressure distinguishes eligible payloads from a protected operational floor", () => {
  assert.deepEqual(
    retentionTarget(
      { days: 1, maxBytes: 2 * MiB },
      "2026-10-03T00:00:00.000Z",
      {
        retainedBytes: 4 * MiB,
        protectedBytes: 3 * MiB,
      },
    ),
    {
      cutoffAt: "2026-10-02T00:00:00.000Z",
      overBudgetBytes: 2 * MiB,
      protectedOverageBytes: MiB,
      eligibleBytes: MiB,
    },
  );
});
test("policy writes reject caller scope, unsupported raw-payload settings and unsafe limits", () => {
  const input = { ...defaultReplayRetention, expectedVersion: null };
  for (const patch of [
    { workspaceId: "foreign" },
    { rawDays: 30 },
    { days: 0 },
    { days: 366 },
    { days: 1.5 },
    { maxBytes: MiB - 1 },
    { maxBytes: Infinity },
    { maxBytes: 1024 ** 4 + 1 },
  ])
    assert.equal(
      updateReplayRetentionSchema.safeParse({ ...input, ...patch }).success,
      false,
    );
  assert.equal(
    replayRetentionSettingsSchema.safeParse(defaultReplayRetention).success,
    true,
  );
});
test("inconsistent usage and malformed timestamps cannot create a pruning target", () => {
  assert.throws(() =>
    retentionTarget(defaultReplayRetention, "not-a-time", empty),
  );
  for (const usage of [
    { retainedBytes: -1, protectedBytes: 0 },
    { retainedBytes: 1, protectedBytes: 2 },
    { retainedBytes: Infinity, protectedBytes: 0 },
  ])
    assert.throws(() =>
      retentionTarget(
        defaultReplayRetention,
        "2026-10-03T00:00:00.000Z",
        usage,
      ),
    );
});
