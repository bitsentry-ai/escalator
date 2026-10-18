import test from "node:test";
import assert from "node:assert/strict";
import { ruleProposalSchema } from "../src/contracts/rule-proposal.js";
import { ruleCatalogEntrySchema } from "../src/contracts/rule-catalog.js";
import { assertRuleCatalogProposal } from "../src/application/rules/catalog-provenance.js";
import { MemoryFoundationRepository } from "./conformance/memory.js";
import { proposalCapture } from "./conformance/proposal-fixture.js";
import { at } from "./conformance/rule-backtest-fixture.js";
const unused = async (): Promise<never> => {
  throw new Error("Unexpected operation");
};
function fixture() {
  const source = proposalCapture(),
    initial = { ...source.snapshot.version, id: "new" },
    d = initial.definition;
  const destination = {
    provider: "ollama",
    model: "local",
    location: "local",
    origin: "http://localhost:11434",
  };
  const proposal = ruleProposalSchema.parse({
    id: "proposal",
    workspaceId: source.workspaceId,
    requestedBy: "operator",
    originLabelId: "label",
    sourceSnapshotId: source.snapshot.snapshotId,
    sourceInputHash: source.inputHash,
    candidateId: initial.id,
    profileId: "model",
    profileRevision: 1,
    destination,
    revision: 4,
    status: "ready",
    failure: null,
    fullRunId: "full",
    heldOutRunId: null,
    heldOut: "insufficient_span",
    createdAt: at(21),
    updatedAt: at(22),
    expiresAt: at(60),
    generation: {
      candidate: initial,
      rationale: "Review",
      destination,
      sourceSnapshotId: source.snapshot.snapshotId,
      sourceInputHash: source.inputHash,
      trainingCutoffAt: at(10),
      usage: { modelCalls: 1, outputTokens: 1 },
      reviewable: false,
    },
  });
  const entry = ruleCatalogEntrySchema.parse({
    id: initial.id,
    workspaceId: d.workspaceId,
    serviceId: d.serviceId,
    environmentId: d.environmentId,
    title: "Candidate",
    revision: 1,
    versionRevision: 1,
    generation: 0,
    status: "draft",
    originProposalId: proposal.id,
    createdAt: at(23),
    updatedAt: at(23),
  });
  const check = () =>
    new MemoryFoundationRepository({ now: () => new Date(at(30)) }).transaction(
      source.workspaceId,
      (base) =>
        assertRuleCatalogProposal(
          {
            ...base,
            replay: {
              currentTime: async () => at(30),
              lock: async () => undefined,
              snapshot: async () => undefined,
              append: unused,
              save: unused,
            },
            reports: {
              chunks: unused,
              labels: unused,
              get: async () => undefined,
              insert: unused,
            },
          },
          entry,
          initial,
          proposal,
        ),
    );
  return { initial, proposal, entry, check };
}
test("matching origin still requires the original evaluation captures and reports", async () => {
  await assert.rejects(fixture().check(), /capture unavailable/);
});
test("changing the original candidate cannot bypass its evaluated proposal", async () => {
  const f = fixture();
  f.initial.definition = { ...f.initial.definition, severity: "critical" };
  await assert.rejects(f.check(), /origin is not an evaluated proposal/);
});
test("a catalog cannot substitute another proposal identifier", async () => {
  const f = fixture();
  f.entry.originProposalId = "other";
  await assert.rejects(f.check(), /scope_violation/);
});
test("later manual revisions retain the original candidate provenance check", async () => {
  const f = fixture();
  f.entry.versionRevision = 2;
  f.entry.revision = 2;
  await assert.rejects(f.check(), /capture unavailable/);
});
