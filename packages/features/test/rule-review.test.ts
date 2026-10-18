import test from "node:test";
import {
  ruleProposalSchema,
  type RuleProposal,
} from "../src/contracts/rule-proposal.js";
import assert from "node:assert/strict";
import { MemoryFoundationRepository } from "./conformance/memory.js";
import { fixture, at } from "./conformance/rule-backtest-fixture.js";
import { workspaceSchema, responderSchema } from "../src/contracts/entities.js";
import {
  ruleCatalogEntrySchema,
  type RuleCatalogEntry,
  type RuleReviewReceipt,
  type RuleActivationHistory,
} from "../src/contracts/rule-catalog.js";
import type { RuleLiveRecord } from "../src/contracts/rule-live.js";
import type { Actor } from "../src/contracts/identity.js";
import { ReviewRuleActivation } from "../src/application/rules/activate.js";
import { RuleDrafts } from "../src/application/rules/catalog.js";
import { replayRuleWindows } from "../src/application/rules/replay.js";
import { summarizeRuleBacktest } from "../src/application/rules/backtest.js";
import { ruleBacktestRecordSchema } from "../src/contracts/backtest-record.js";
import { ruleActivationEligibility } from "../src/application/rules/review-eligibility.js";
import type {
  RuleCatalogRepository,
  RuleCatalogStore,
} from "../src/application/rules/activation-ports.js";
async function setup() {
  const snapshot = fixture(),
    version = snapshot.version,
    d = version.definition;
  const responder = responderSchema.parse({
    id: "reviewer",
    workspaceId: d.workspaceId,
    hostUserId: "local",
    displayName: "Reviewer",
    timeZone: "UTC",
    role: "administrator",
    enabled: true,
    createdAt: at(0),
    updatedAt: at(0),
  });
  const actor: Actor = {
    workspaceId: d.workspaceId,
    responderId: responder.id,
    role: responder.role,
  };
  const control = {
    now: at(21),
    revoked: false,
    changedCoverage: false,
    failEnqueue: false,
    policy: true,
    proposal: undefined as RuleProposal | undefined,
    failEvidence: false,
    operations: [] as string[],
  };
  const foundation = new MemoryFoundationRepository({
    now: () => new Date(control.now),
  });
  await foundation.transaction(actor.workspaceId, async (tx) => {
    await tx.workspace.insert(
      workspaceSchema.parse({
        id: actor.workspaceId,
        name: "Rules",
        createdAt: at(0),
        updatedAt: at(0),
      }),
    );
    await tx.responders.insert(responder);
  });
  const record = ruleBacktestRecordSchema.parse({
    workspaceId: d.workspaceId,
    runId: "report",
    snapshotId: snapshot.snapshotId,
    inputHash: "a".repeat(64),
    labelHash: "b".repeat(64),
    createdAt: at(20),
    report: summarizeRuleBacktest(
      snapshot,
      replayRuleWindows(snapshot, null, {
        maxDecisions: 1440,
        maxSampleVisits: 1000000,
      }).decisions,
      [],
    ),
  });
  let state: {
    entry: RuleCatalogEntry;
    versions: (typeof version)[];
    reviews: RuleReviewReceipt[];
    history: RuleActivationHistory[];
    runtime: RuleLiveRecord | undefined;
  } = {
    entry: ruleCatalogEntrySchema.parse({
      id: version.id,
      workspaceId: d.workspaceId,
      serviceId: d.serviceId,
      environmentId: d.environmentId,
      title: "Rule",
      revision: 1,
      versionRevision: version.revision,
      generation: 0,
      status: "draft",
      originProposalId: null,
      createdAt: at(0),
      updatedAt: at(0),
    }),
    versions: [version],
    reviews: [],
    history: [],
    runtime: undefined,
  };
  const repository: RuleCatalogRepository = {
    transaction: async (scope, work) => {
      const draft = structuredClone(state);
      const result = await foundation.transaction(scope, async (tx) => {
        const catalog: RuleCatalogStore = {
          currentTime: async () => control.now,
          proposal: async () => control.proposal,
          lockDefinition: async () => {
            control.operations.push("source");
          },
          lock: async (id) => (id === draft.entry.id ? draft.entry : undefined),
          version: async (id, revision) =>
            draft.versions.find((v) => v.id === id && v.revision === revision),
          latestVersionRevision: async () =>
            Math.max(...draft.versions.map((v) => v.revision)),
          insert: async (entry, v) => {
            if (entry.id === draft.entry.id) throw new Error("duplicate draft");
            control.operations.push("insert");
            draft.entry = entry;
            draft.versions = [v];
          },
          insertVersion: async (v) => {
            draft.versions.push(v);
          },
          save: async (entry, expected) => {
            if (draft.entry.revision !== expected) return false;
            draft.entry = entry;
            return true;
          },
          runtime: async () => draft.runtime,
          retireRuntime: async () => {
            draft.runtime = undefined;
          },
          activateRuntime: async (row) => {
            draft.runtime = row;
          },
          review: async (id) => draft.reviews.find((r) => r.id === id),
          insertReview: async (row) => {
            draft.reviews.push(row);
          },
          history: async (row) => {
            draft.history.push(row);
          },
          evidence: async (_entry, _version, runId) => {
            control.operations.push("evidence");
            if (control.failEvidence)
              throw new Error("proposal provenance changed");
            return {
              measurementHash: "a".repeat(64),
              policyKnown: true,
              policyEnabled: control.policy,
              report: runId ? record : null,
              fingerprint: {
                versionHash: "a".repeat(64),
                measurementHash: "a".repeat(64),
                coverageHash: (control.changedCoverage ? "c" : "a").repeat(64),
                policyHash: (control.policy ? "a" : "b").repeat(64),
                labelHash: "b".repeat(64),
                reportHash: runId ? "a".repeat(64) : null,
              },
            };
          },
        };
        return work({
          ...tx,
          catalog,
          responders: {
            ...tx.responders,
            get: async (id) => {
              const value = await tx.responders.get(id);
              return value && control.revoked
                ? { ...value, enabled: false }
                : value;
            },
          },
          work: {
            ...tx.work,
            enqueue: async (...args) => {
              if (control.failEnqueue) throw new Error("queue unavailable");
              return tx.work.enqueue(...args);
            },
          },
        });
      });
      state = draft;
      return result;
    },
  };
  let serial = 0;
  const reviews = new ReviewRuleActivation(
      repository,
      () => `receipt-${++serial}`,
    ),
    drafts = new RuleDrafts(repository, () => `draft-${++serial}`);
  const review = () =>
    reviews.review(actor, {
      ruleId: version.id,
      expectedRevision: state.entry.revision,
      versionRevision: state.entry.versionRevision,
      mode: "active",
      runId: "report",
    });
  return {
    actor,
    control,
    version,
    record,
    reviews,
    drafts,
    review,
    state: () => state,
  };
}
test("activation atomically records a new epoch, history and scheduled runtime", async () => {
  const x = await setup(),
    receipt = await x.review();
  const row = await x.reviews.activate(x.actor, {
    ruleId: x.version.id,
    receiptId: receipt.id,
  });
  assert.equal(row.status, "active");
  assert.equal(row.generation, 1);
  assert.equal(x.state().runtime?.state, null);
  assert.equal(x.state().runtime?.incidentId, null);
  assert.equal(x.state().history[0].actorId, x.actor.responderId);
  await assert.rejects(
    x.reviews.activate(x.actor, {
      ruleId: x.version.id,
      receiptId: receipt.id,
    }),
    /changed after review/,
  );
});
test("coverage changes invalidate approval without replacing runtime", async () => {
  const x = await setup(),
    receipt = await x.review();
  x.control.changedCoverage = true;
  await assert.rejects(
    x.reviews.activate(x.actor, {
      ruleId: x.version.id,
      receiptId: receipt.id,
    }),
    /evidence changed/,
  );
  assert.equal(x.state().entry.status, "draft");
  assert.equal(x.state().history.length, 0);
});
test("expiry is exclusive and current responder authorization is repeated", async () => {
  const x = await setup(),
    receipt = await x.review();
  x.control.now = receipt.expiresAt;
  await assert.rejects(
    x.reviews.activate(x.actor, {
      ruleId: x.version.id,
      receiptId: receipt.id,
    }),
    /expired/,
  );
  x.control.now = at(22);
  x.control.revoked = true;
  await assert.rejects(
    x.reviews.activate(x.actor, {
      ruleId: x.version.id,
      receiptId: receipt.id,
    }),
    /forbidden/,
  );
});
test("a queue failure rolls back catalog, history and runtime", async () => {
  const x = await setup(),
    receipt = await x.review();
  x.control.failEnqueue = true;
  await assert.rejects(
    x.reviews.activate(x.actor, {
      ruleId: x.version.id,
      receiptId: receipt.id,
    }),
    /queue unavailable/,
  );
  assert.equal(x.state().entry.revision, 1);
  assert.equal(x.state().runtime, undefined);
  assert.equal(x.state().history.length, 0);
});
test("a policy change prevents activation", async () => {
  const x = await setup(),
    receipt = await x.review();
  x.control.policy = false;
  await assert.rejects(
    x.reviews.activate(x.actor, {
      ruleId: x.version.id,
      receiptId: receipt.id,
    }),
    /evidence changed/,
  );
});
test("unknown history may be reviewed for shadow but not active paging", async () => {
  const x = await setup();
  await assert.rejects(
    x.reviews.review(x.actor, {
      ruleId: x.version.id,
      expectedRevision: 1,
      versionRevision: 1,
      mode: "active",
      runId: null,
    }),
    /report_required/,
  );
  const receipt = await x.reviews.review(x.actor, {
    ruleId: x.version.id,
    expectedRevision: 1,
    versionRevision: 1,
    mode: "shadow",
    runId: null,
  });
  const row = await x.reviews.activate(x.actor, {
    ruleId: x.version.id,
    receiptId: receipt.id,
  });
  assert.equal(row.status, "shadow");
});
test("editing invalidates approval and appends an immutable content version", async () => {
  const x = await setup(),
    receipt = await x.review();
  await x.drafts.edit(x.actor, {
    ruleId: x.version.id,
    expectedRevision: 1,
    definition: x.version.definition,
  });
  assert.equal(x.state().versions.length, 2);
  assert.equal(x.state().versions[0].revision, 1);
  await assert.rejects(
    x.reviews.activate(x.actor, {
      ruleId: x.version.id,
      receiptId: receipt.id,
    }),
    /changed after review/,
  );
});
test("a live rule must be retired before a manual definition edit", async () => {
  const x = await setup(),
    receipt = await x.review();
  await x.reviews.activate(x.actor, {
    ruleId: x.version.id,
    receiptId: receipt.id,
  });
  await assert.rejects(
    x.drafts.edit(x.actor, {
      ruleId: x.version.id,
      expectedRevision: 2,
      definition: x.version.definition,
    }),
    /Retire/,
  );
  await x.reviews.retire(x.actor, {
    ruleId: x.version.id,
    expectedRevision: 2,
  });
  const row = await x.drafts.edit(x.actor, {
    ruleId: x.version.id,
    expectedRevision: 3,
    definition: x.version.definition,
  });
  assert.equal(row.status, "draft");
  assert.equal(row.versionRevision, 2);
  assert.equal(x.state().runtime, undefined);
});
test("unlabeled usable evidence does not manufacture precision", async () => {
  const x = await setup();
  assert.equal(ruleActivationEligibility(x.version, x.record).eligible, true);
  assert.equal(x.record.report.precision.value, null);
});

test("rollback uses an explicitly reviewed older version and a fresh epoch", async () => {
  const x = await setup(),
    first = await x.review();
  await x.reviews.activate(x.actor, {
    ruleId: x.version.id,
    receiptId: first.id,
  });
  await x.reviews.retire(x.actor, {
    ruleId: x.version.id,
    expectedRevision: 2,
  });
  await x.drafts.edit(x.actor, {
    ruleId: x.version.id,
    expectedRevision: 3,
    definition: x.version.definition,
  });
  const shadow = await x.reviews.review(x.actor, {
    ruleId: x.version.id,
    expectedRevision: 4,
    versionRevision: 2,
    mode: "shadow",
    runId: null,
  });
  await x.reviews.activate(x.actor, {
    ruleId: x.version.id,
    receiptId: shadow.id,
  });
  const receipt = await x.reviews.review(x.actor, {
    ruleId: x.version.id,
    expectedRevision: 5,
    versionRevision: 1,
    mode: "active",
    runId: "report",
  });
  const row = await x.reviews.activate(x.actor, {
    ruleId: x.version.id,
    receiptId: receipt.id,
  });
  assert.equal(row.generation, 3);
  assert.equal(row.versionRevision, 1);
  assert.equal(x.state().runtime?.state, null);
  assert.equal(x.state().history.at(-1)?.action, "rolled_back");
  await x.reviews.retire(x.actor, {
    ruleId: x.version.id,
    expectedRevision: 6,
  });
  const edited = await x.drafts.edit(x.actor, {
    ruleId: x.version.id,
    expectedRevision: 7,
    definition: x.version.definition,
  });
  assert.equal(edited.versionRevision, 3);
});

test("isolated post-gap history cannot satisfy a persistence interval", () => {
  const snapshot = fixture();
  snapshot.version.definition.persistenceSeconds = 120;
  const all = snapshot.samples;
  snapshot.samples = all.slice(-1);
  const evaluate = () =>
    ruleActivationEligibility(
      snapshot.version,
      ruleBacktestRecordSchema.parse({
        workspaceId: snapshot.version.definition.workspaceId,
        runId: "duration-report",
        snapshotId: snapshot.snapshotId,
        inputHash: "a".repeat(64),
        labelHash: "b".repeat(64),
        createdAt: at(20),
        report: summarizeRuleBacktest(
          snapshot,
          replayRuleWindows(snapshot, null, {
            maxDecisions: 1440,
            maxSampleVisits: 1000000,
          }).decisions,
          [],
        ),
      }),
    );
  assert.equal(evaluate().reason, "insufficient_history");
  snapshot.samples = all.slice(-3);
  assert.equal(evaluate().eligible, true);
  snapshot.version.definition.recoverySeconds = 180;
  assert.equal(evaluate().reason, "insufficient_history");
  snapshot.samples = all.slice(-4);
  assert.equal(evaluate().eligible, true);
});

function readyProposal(version: Awaited<ReturnType<typeof setup>>["version"]) {
  const destination = {
    provider: "ollama",
    model: "local",
    location: "local",
    origin: "http://localhost:11434",
  };
  return ruleProposalSchema.parse({
    id: "proposal",
    workspaceId: version.definition.workspaceId,
    requestedBy: "reviewer",
    originLabelId: "label",
    sourceSnapshotId: "source",
    sourceInputHash: "a".repeat(64),
    candidateId: "adopted",
    profileId: "model",
    profileRevision: 1,
    destination,
    revision: 4,
    status: "ready",
    failure: null,
    fullRunId: "full",
    heldOutRunId: null,
    heldOut: "insufficient_span",
    createdAt: at(0),
    updatedAt: at(20),
    expiresAt: at(60),
    generation: {
      candidate: { ...version, id: "adopted", revision: 1 },
      rationale: "Review this candidate",
      destination,
      sourceSnapshotId: "source",
      sourceInputHash: "a".repeat(64),
      trainingCutoffAt: at(10),
      usage: { modelCalls: 1, outputTokens: 1 },
      reviewable: false,
    },
  });
}
test("human adoption preserves evaluated candidate provenance and never activates", async () => {
  const x = await setup();
  x.control.proposal = readyProposal(x.version);
  const entry = await x.drafts.adopt(x.actor, {
    proposalId: "proposal",
    title: "Reviewed candidate",
  });
  assert.equal(entry.id, "adopted");
  assert.equal(entry.originProposalId, "proposal");
  assert.equal(entry.status, "draft");
  assert.equal(entry.generation, 0);
  assert.equal(x.state().runtime, undefined);
  assert.deepEqual(
    x.state().versions[0],
    x.control.proposal.generation!.candidate,
  );
  assert.deepEqual(x.control.operations, ["source", "insert", "evidence"]);
  assert.equal(x.state().history[0].action, "drafted");
  await assert.rejects(
    x.drafts.adopt(x.actor, { proposalId: "proposal", title: "Duplicate" }),
    /duplicate/,
  );
  assert.equal(x.state().history.length, 1);
});
test("failed locked provenance rolls back the draft and its history", async () => {
  const x = await setup(),
    before = structuredClone(x.state());
  x.control.proposal = readyProposal(x.version);
  x.control.failEvidence = true;
  await assert.rejects(
    x.drafts.adopt(x.actor, { proposalId: "proposal", title: "Candidate" }),
    /provenance changed/,
  );
  assert.deepEqual(x.state(), before);
});
test("adoption rejects disabled and read-only responders before writing", async () => {
  const x = await setup();
  x.control.proposal = readyProposal(x.version);
  x.control.revoked = true;
  await assert.rejects(
    x.drafts.adopt(x.actor, { proposalId: "proposal", title: "Candidate" }),
    /forbidden/,
  );
  x.control.revoked = false;
  await assert.rejects(
    x.drafts.adopt(
      { ...x.actor, role: "viewer" },
      { proposalId: "proposal", title: "Candidate" },
    ),
    /forbidden/,
  );
  assert.deepEqual(x.control.operations, []);
});
test("adoption rejects unfinished or substituted proposals", async () => {
  const x = await setup();
  const proposal = readyProposal(x.version);
  x.control.proposal = { ...proposal, status: "evaluating" };
  await assert.rejects(
    x.drafts.adopt(x.actor, { proposalId: "proposal", title: "Candidate" }),
    /not complete/,
  );
  x.control.proposal = { ...proposal, id: "other" };
  await assert.rejects(
    x.drafts.adopt(x.actor, { proposalId: "proposal", title: "Candidate" }),
  );
  assert.deepEqual(x.control.operations, []);
});

test("a metric monitor cannot be activated for double paging but remains available in shadow", async () => {
  const x = await setup();
  x.version.definition.selector = {
    kind: "metric",
    streamId: "monitor",
    field: "error_rate",
    minimumRequests: 1,
  };
  await assert.rejects(x.review(), /paging metric monitor; use shadow mode/);
  const receipt = await x.reviews.review(x.actor, {
    ruleId: x.version.id,
    expectedRevision: x.state().entry.revision,
    versionRevision: x.version.revision,
    mode: "shadow",
    runId: null,
  });
  const row = await x.reviews.activate(x.actor, {
    ruleId: x.version.id,
    receiptId: receipt.id,
  });
  assert.equal(row.status, "shadow");
});
