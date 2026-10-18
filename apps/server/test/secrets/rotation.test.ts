import test from "node:test";
import assert from "node:assert/strict";
import { rotateKeys } from "../../src/platform/secrets/rotate-keys.js";
test("key rotation advances in bounded batches and reports remaining conflicts", async () => {
  const cursors: (string | undefined)[] = [];
  const result = await rotateKeys(async (after) => {
    cursors.push(after);
    return after
      ? { rotated: 0, conflicts: 0, remaining: 1 }
      : { rotated: 2, conflicts: 1, remaining: 1, next: "last_seen" };
  });
  assert.deepEqual(cursors, [undefined, "last_seen"]);
  assert.deepEqual(result, { rotated: 2, conflicts: 1, remaining: 1 });
});
test("a non-advancing rotation cursor fails instead of looping indefinitely", async () => {
  await assert.rejects(
    rotateKeys(async () => ({
      rotated: 0,
      conflicts: 0,
      remaining: 1,
      next: "same",
    })),
    /did not advance/,
  );
});
