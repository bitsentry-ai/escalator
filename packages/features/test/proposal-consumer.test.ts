import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fixture, at } from "./conformance/rule-backtest-fixture.js";
import {
  ruleProposalClaimSchema,
  type RuleCandidateResult,
} from "../src/contracts/rule-proposal.js";
import { prepareRuleCandidate } from "../src/application/rules/prepare-candidate.js";
import {
  executeRuleProposalClaim,
  RuleProposalConsumer,
  type RuleProposalExecutionPort,
  type RuleProposalExecution,
} from "../src/application/rules/proposal-consumer.js";
function setup() {
  const snapshot = fixture(),
    workspaceId = snapshot.version.definition.workspaceId;
  const input = prepareRuleCandidate({
    source: {
      workspaceId,
      snapshot,
      inputHash: createHash("sha256")
        .update(JSON.stringify(snapshot))
        .digest("hex"),
    },
    labels: [],
    profileId: "model",
    candidateId: "candidate",
  });
  const claim = ruleProposalClaimSchema.parse({
    workspaceId,
    proposalId: "proposal",
    runtimeId: "runtime",
    token: "token",
    attempt: 1,
    leaseExpiresAt: at(22),
  });
  const result: RuleCandidateResult = {
    candidate: { ...snapshot.version, id: input.candidateId },
    rationale: "Review",
    destination: {
      provider: "ollama",
      model: "local",
      location: "local",
      origin: "http://localhost:11434",
    },
    sourceSnapshotId: input.sourceSnapshotId,
    sourceInputHash: input.sourceInputHash,
    trainingCutoffAt: input.context.cutoffAt,
    usage: { modelCalls: 1, outputTokens: 1 },
    reviewable: false,
  };
  const counts = { claim: 0, complete: 0, failed: 0, execute: 0 };
  const port: RuleProposalExecutionPort = {
    claim: async () => {
      counts.claim++;
      return claim;
    },
    heartbeat: async () => true,
    prepare: async () => input,
    complete: async () => {
      counts.complete++;
      return true;
    },
    failed: async () => {
      counts.failed++;
      return true;
    },
  };
  const execute: RuleProposalExecution = async () => {
    counts.execute++;
    return result;
  };
  return { claim, input, result, counts, port, execute };
}
test("a generated candidate is published once through the durable port", async () => {
  const f = setup();
  assert.equal(
    await executeRuleProposalClaim(
      f.claim,
      f.port,
      f.execute,
      new AbortController().signal,
    ),
    "published",
  );
  assert.deepEqual(f.counts, { claim: 0, complete: 1, failed: 0, execute: 1 });
});
test("a lost publication response is never followed by a failure write", async () => {
  const f = setup();
  f.port.complete = async () => {
    f.counts.complete++;
    throw new Error("response lost after commit");
  };
  assert.equal(
    await executeRuleProposalClaim(
      f.claim,
      f.port,
      f.execute,
      new AbortController().signal,
    ),
    "publication_unknown",
  );
  assert.equal(f.counts.failed, 0);
  assert.equal(f.counts.complete, 1);
});
test("shutdown interrupts a non-cooperative model and leaves the claim reclaimable", async () => {
  const f = setup(),
    stop = new AbortController();
  const execute: RuleProposalExecution = async () => {
    stop.abort();
    return new Promise(() => {});
  };
  assert.equal(
    await executeRuleProposalClaim(f.claim, f.port, execute, stop.signal),
    "stopped",
  );
  assert.equal(f.counts.failed, 0);
  assert.equal(f.counts.complete, 0);
});
test("a model failure records a proposal failure without publishing", async () => {
  const f = setup();
  assert.equal(
    await executeRuleProposalClaim(
      f.claim,
      f.port,
      async () => {
        throw new Error("provider failed");
      },
      new AbortController().signal,
    ),
    "failed",
  );
  assert.equal(f.counts.failed, 1);
  assert.equal(f.counts.complete, 0);
});
test("missing preparation and wrong-scope inputs never reach the model", async () => {
  const f = setup();
  f.port.prepare = async () => undefined;
  assert.equal(
    await executeRuleProposalClaim(
      f.claim,
      f.port,
      f.execute,
      new AbortController().signal,
    ),
    "unavailable",
  );
  f.port.prepare = async () => ({
    ...f.input,
    seedVersion: {
      ...f.input.seedVersion,
      definition: {
        ...f.input.seedVersion.definition,
        workspaceId: ruleProposalClaimSchema.parse({
          ...f.claim,
          workspaceId: "other",
        }).workspaceId,
      },
    },
  });
  assert.equal(
    await executeRuleProposalClaim(
      f.claim,
      f.port,
      f.execute,
      new AbortController().signal,
    ),
    "failed",
  );
  assert.equal(f.counts.execute, 0);
});
test("concurrent polls share one claim operation and only one model slot", async () => {
  const f = setup();
  let release: (value: typeof f.claim) => void = () => {};
  f.port.claim = async () => {
    f.counts.claim++;
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const consumer = new RuleProposalConsumer(
    f.port,
    async () => new Promise(() => {}),
    {
      workspaceId: f.claim.workspaceId,
      runtimeId: f.claim.runtimeId,
      token: () => "token",
    },
  );
  const a = consumer.tick(),
    b = consumer.tick();
  assert.equal(a, b);
  await Promise.resolve();
  release(f.claim);
  await a;
  assert.equal(consumer.active, 1);
  await consumer.tick();
  assert.equal(f.counts.claim, 1);
  await consumer.stop();
  assert.equal(consumer.active, 0);
  assert.equal(f.counts.failed, 0);
});
test("a claim for another runtime is rejected before preparation", async () => {
  const f = setup();
  f.port.claim = async () => ({ ...f.claim, runtimeId: "other" });
  let seen = "";
  const consumer = new RuleProposalConsumer(
    f.port,
    f.execute,
    {
      workspaceId: f.claim.workspaceId,
      runtimeId: f.claim.runtimeId,
      token: () => "token",
    },
    (state) => {
      seen = state;
    },
  );
  await consumer.tick();
  await consumer.stop();
  assert.equal(seen, "claim_failed");
  assert.equal(f.counts.execute, 0);
});
