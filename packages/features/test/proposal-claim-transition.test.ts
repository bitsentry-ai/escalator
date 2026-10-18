import test from "node:test";
import assert from "node:assert/strict";
import { ruleProposalSchema } from "../src/contracts/rule-proposal.js";
import {
  transitionRuleProposalClaim,
  ruleProposalClaimDisposition,
} from "../src/application/rules/proposal-claim-transition.js";
const at = (minute: number) =>
  new Date(Date.parse("2026-10-07T00:00:00Z") + minute * 60000).toISOString();
function queued() {
  return ruleProposalSchema.parse({
    id: "proposal",
    workspaceId: "org",
    requestedBy: "operator",
    originLabelId: "label",
    sourceSnapshotId: "snapshot",
    sourceInputHash: "a".repeat(64),
    candidateId: "candidate",
    profileId: "profile",
    profileRevision: 1,
    revision: 1,
    status: "queued",
    destination: {
      provider: "ollama",
      model: "local",
      location: "local",
      origin: "http://127.0.0.1:11434",
    },
    generation: null,
    failure: null,
    fullRunId: null,
    heldOutRunId: null,
    heldOut: "insufficient_span",
    createdAt: at(0),
    updatedAt: at(0),
    expiresAt: at(10),
  });
}
test("reclaim preserves proposal identity and creates distinct safe audit identities", () => {
  const first = transitionRuleProposalClaim(queued(), at(1), "claimed"),
    second = transitionRuleProposalClaim(first.row, at(2), "claimed");
  assert.equal(first.row.status, "generating");
  assert.equal(second.row.revision, 3);
  assert.equal(second.row.sourceInputHash, first.row.sourceInputHash);
  assert.notEqual(first.audit.id, second.audit.id);
  assert.deepEqual(second.audit.metadata, { revision: 3, outcome: "claimed" });
});
test("expired and exhausted generations remain unreviewable terminal failures", () => {
  const claimed = transitionRuleProposalClaim(queued(), at(1), "claimed").row;
  const expired = transitionRuleProposalClaim(claimed, at(10), "expired").row;
  assert.equal(expired.failure, "expired");
  assert.equal(expired.generation, null);
  assert.throws(() => transitionRuleProposalClaim(expired, at(11), "claimed"));
  const exhausted = transitionRuleProposalClaim(
    claimed,
    at(2),
    "exhausted",
  ).row;
  assert.equal(exhausted.failure, "generation_failed");
  assert.equal(exhausted.fullRunId, null);
});
test("fresh database time cannot backdate a revision or prematurely expire a proposal", () => {
  const claimed = transitionRuleProposalClaim(queued(), at(2), "claimed").row;
  assert.throws(() => transitionRuleProposalClaim(claimed, at(1), "claimed"));
  assert.throws(() => transitionRuleProposalClaim(claimed, at(3), "expired"));
  assert.throws(() => transitionRuleProposalClaim(claimed, at(10), "claimed"));
});

test("missing generation jobs are audited as abandoned, not exhausted attempts", () => {
  const failed = transitionRuleProposalClaim(queued(), at(1), "abandoned");
  assert.equal(failed.row.failure, "generation_failed");
  assert.equal(failed.audit.metadata.outcome, "abandoned");
  assert.equal(failed.row.generation, null);
});

test("a live last attempt cannot be stolen, but expired attempts exhaust", () => {
  const row = queued(),
    job = { state: "running", attempt: 3, dueAt: at(0), leaseExpiresAt: at(2) };
  assert.equal(ruleProposalClaimDisposition(row, job, at(1)), "busy");
  assert.equal(ruleProposalClaimDisposition(row, job, at(2)), "exhausted");
  assert.equal(
    ruleProposalClaimDisposition(row, { ...job, attempt: 2 }, at(2)),
    "claimed",
  );
  assert.equal(
    ruleProposalClaimDisposition(
      row,
      { ...job, leaseExpiresAt: at(11) },
      at(10),
    ),
    "expired",
  );
});
test("future jobs wait and missing or terminal jobs are abandoned", () => {
  const row = queued(),
    job = { state: "pending", attempt: 0, dueAt: at(2), leaseExpiresAt: null };
  assert.equal(ruleProposalClaimDisposition(row, job, at(1)), "busy");
  assert.equal(ruleProposalClaimDisposition(row, job, at(2)), "claimed");
  assert.equal(
    ruleProposalClaimDisposition(row, undefined, at(1)),
    "abandoned",
  );
  assert.equal(
    ruleProposalClaimDisposition(row, { ...job, state: "cancelled" }, at(1)),
    "abandoned",
  );
  assert.throws(() =>
    ruleProposalClaimDisposition(row, { ...job, state: "running" }, at(1)),
  );
});
