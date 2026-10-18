import test from "node:test";
import assert from "node:assert/strict";
import { ruleProposalSchema } from "../src/contracts/rule-proposal.js";
import { workspaceIdSchema } from "../src/contracts/identity.js";
import {
  encodeRuleProposal,
  decodeRuleProposal,
  RuleProposalLeaseFence,
} from "../src/application/rules/proposal-storage.js";
import { fixture, at } from "./conformance/rule-backtest-fixture.js";
const scope = workspaceIdSchema.parse("org");
function proposal() {
  return ruleProposalSchema.parse({
    id: "proposal",
    workspaceId: scope,
    requestedBy: "operator",
    originLabelId: "label",
    sourceSnapshotId: "snapshot",
    sourceInputHash: "a".repeat(64),
    candidateId: "candidate",
    profileId: "profile",
    profileRevision: 1,
    revision: 3,
    status: "evaluating",
    destination: {
      provider: "ollama",
      model: "local",
      location: "local",
      origin: "http://127.0.0.1:11434",
    },
    generation: {
      candidate: { ...fixture().version, id: "candidate" },
      rationale: "Check failures",
      destination: {
        provider: "ollama",
        model: "local",
        location: "local",
        origin: "http://127.0.0.1:11434",
      },
      sourceSnapshotId: "snapshot",
      sourceInputHash: "a".repeat(64),
      trainingCutoffAt: at(8),
      usage: { modelCalls: 1, outputTokens: 10 },
      reviewable: false,
    },
    failure: null,
    fullRunId: null,
    heldOutRunId: null,
    heldOut: "required",
    createdAt: at(20),
    updatedAt: at(21),
    expiresAt: at(80),
  });
}
test("proposal storage removes all logical tenant copies and restores nested candidate scope", () => {
  const row = proposal(),
    encoded = encodeRuleProposal(scope, row);
  assert.equal(encoded.includes('"workspaceId"'), false);
  assert.deepEqual(decodeRuleProposal(scope, JSON.parse(encoded)), row);
  assert.throws(() =>
    encodeRuleProposal(workspaceIdSchema.parse("other"), row),
  );
  const data = JSON.parse(encoded);
  data.candidateId = "different";
  assert.throws(() => decodeRuleProposal(scope, data));
});
test("proposal decoder validates generation and readiness bindings", () => {
  const data = JSON.parse(encodeRuleProposal(scope, proposal()));
  data.status = "ready";
  assert.throws(() => decodeRuleProposal(scope, data));
  data.status = "evaluating";
  data.generation.sourceInputHash = "b".repeat(64);
  assert.throws(() => decodeRuleProposal(scope, data));
});
test("lease fence includes SQL latency and cannot be extended by a later bind", () => {
  let now = 10;
  const fence = new RuleProposalLeaseFence(() => now),
    started = fence.start();
  now = 60;
  fence.bind(started, 100); // Effective deadline 110, not 160.
  fence.bind(now, 1000);
  now = 109;
  fence.assertLive();
  now = 110;
  assert.throws(() => fence.assertLive());
});
test("lease fence catches delayed event-loop callbacks without relying on timers", () => {
  let now = 0;
  const fence = new RuleProposalLeaseFence(() => now);
  fence.bind(fence.start(), 50);
  now = 51;
  assert.throws(() => fence.assertLive());
  for (const remaining of [0, -1, NaN, Infinity, 120001])
    assert.throws(() => new RuleProposalLeaseFence(() => 0).bind(0, remaining));
});
