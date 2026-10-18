import test from "node:test";
import assert from "node:assert/strict";
import { workspaceIdSchema } from "../src/contracts/identity.js";
import { ruleReplayRunSchema } from "../src/contracts/replay-run.js";
import {
  encodeRuleReplayData,
  decodeRuleReplayRun,
  decodeRuleReplaySnapshot,
} from "../src/application/rules/replay-storage-codec.js";
const scope = workspaceIdSchema.parse("org-a");
function run() {
  return ruleReplayRunSchema.parse({
    id: "run",
    workspaceId: scope,
    snapshotId: "snapshot",
    inputHash: "a".repeat(64),
    revision: 2,
    status: "running",
    nextBatch: 1,
    decisionCount: 1,
    createdAt: "2026-10-07T01:00:00.000Z",
    updatedAt: "2026-10-07T01:01:00.000Z",
    cursor: {
      snapshotId: "snapshot",
      state: {
        workspaceId: scope,
        serviceId: "api",
        environmentId: "prod",
        ruleId: "rule",
        revision: 1,
        evaluatorVersion: 1,
        lastDecisionAt: "2026-10-07T00:01:00.000Z",
        activeSince: null,
        triggerSince: null,
        recoverySince: null,
        cooldownUntil: null,
      },
    },
  });
}
test("run storage removes every tenant field and restores it from the host scope", () => {
  const row = run(),
    encoded = encodeRuleReplayData(scope, "run", row);
  assert.equal(encoded.includes("workspaceId"), false);
  assert.equal(encoded.includes("org-a"), false);
  assert.deepEqual(decodeRuleReplayRun(scope, JSON.parse(encoded)), row);
});
test("a JSON tenant value cannot override the canonical SQL tenant", () => {
  const raw = JSON.parse(encodeRuleReplayData(scope, "run", run()));
  raw.workspaceId = "forged";
  raw.cursor.state.workspaceId = "forged";
  const restored = decodeRuleReplayRun(scope, raw);
  assert.equal(restored.workspaceId, scope);
  assert.equal(restored.cursor!.state.workspaceId, scope);
});
test("writes reject foreign scope and malformed reads remain errors", () => {
  assert.throws(
    () => encodeRuleReplayData(workspaceIdSchema.parse("other"), "run", run()),
    /scope_violation/,
  );
  assert.throws(() => decodeRuleReplayRun(scope, { id: "run", cursor: null }));
  assert.throws(() =>
    decodeRuleReplaySnapshot(scope, {
      inputHash: "a".repeat(64),
      snapshot: { samples: [] },
    }),
  );
});
