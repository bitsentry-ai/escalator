import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { MemoryFoundationRepository } from "./conformance/memory.js";
import { fixture, label, at } from "./conformance/rule-backtest-fixture.js";
import { workspaceSchema, responderSchema } from "../src/contracts/entities.js";
import { ruleReplaySnapshotSchema } from "../src/contracts/rule-replay.js";
import { storedRuleReplaySnapshotSchema } from "../src/contracts/replay-run.js";
import { modelProfileSchema } from "../src/contracts/model-profile.js";
import {
  ruleProposalClaimSchema,
  type RuleProposal,
  type RuleProposalClaim,
  type RuleCandidateResult,
} from "../src/contracts/rule-proposal.js";
import { RuleProposalGeneration } from "../src/application/rules/proposal-generation.js";
import { withRuleProposals } from "../src/application/rules/proposal-transaction.js";
import type {
  RuleProposalRepository,
  RuleProposalTransaction,
} from "../src/application/rules/proposal-ports.js";
import type { Actor } from "../src/contracts/identity.js";
const unused = async (): Promise<never> => {
  throw new Error("unexpected operation");
};
async function setup() {
  const old = fixture(),
    d = old.version.definition;
  const snapshot = ruleReplaySnapshotSchema.parse({
    ...old,
    samples: [],
    coverage: [],
    policies: [],
    complete: false,
    retained: {
      measurementHash: "a".repeat(64),
      policyFacts: [],
      policyComplete: false,
      history: {
        workspaceId: d.workspaceId,
        serviceId: d.serviceId,
        environmentId: d.environmentId,
        kind: d.selector.kind,
        streamId: d.selector.streamId,
        snapshotAt: old.snapshotAt,
        visibleAt: old.snapshotAt,
        startAt: at(0),
        endAt: at(10),
        complete: false,
        configurations: [],
        receipts: [],
      },
    },
  });
  const source = storedRuleReplaySnapshotSchema.parse({
    workspaceId: d.workspaceId,
    snapshot,
    inputHash: createHash("sha256")
      .update(JSON.stringify(snapshot))
      .digest("hex"),
  });
  const control = {
    now: at(21),
    failSchedule: false,
    revoked: false,
    profileRevision: 1,
  };
  const foundation = new MemoryFoundationRepository({
    now: () => new Date(control.now),
  });
  const responder = responderSchema.parse({
    id: "operator",
    workspaceId: d.workspaceId,
    hostUserId: "local",
    displayName: "Operator",
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
  const origin = label("review", 2, 3);
  const profile = modelProfileSchema.parse({
    id: "model",
    revision: 1,
    scope: {
      workspaceId: d.workspaceId,
      serviceId: d.serviceId,
      environmentId: d.environmentId,
    },
    destination: {
      provider: "ollama",
      model: "local",
      location: "local",
      origin: "http://localhost:11434",
    },
    endpoint: "http://localhost:11434",
    secretId: null,
  });
  type State = {
    rows: RuleProposal[];
    claim: RuleProposalClaim | null;
    scheduled: string[];
  };
  const repository: RuleProposalRepository = {
    transaction: (scope, work) =>
      foundation.withExtensions(scope, async (base, extensions, guard) => {
        const state = (extensions.proposals ??= {
          rows: [],
          claim: null,
          scheduled: [],
        }) as State;
        const tx: Omit<RuleProposalTransaction, "proposals"> = {
          ...base,
          responders: {
            ...base.responders,
            get: async (id) =>
              control.revoked ? undefined : base.responders.get(id),
          },
          replay: {
            currentTime: async () => control.now,
            lock: unused,
            snapshot: async (id) =>
              id === snapshot.snapshotId ? structuredClone(source) : undefined,
            append: unused,
            save: unused,
          },
          capture: { reserve: unused, evidence: unused, insert: unused },
          reports: {
            chunks: unused,
            labels: async () => [origin],
            get: unused,
            insert: unused,
          },
        };
        return work(
          withRuleProposals(
            tx,
            {
              evaluatingIds: unused,
              workState: unused,
              currentTime: async () => control.now,
              lock: async (id) =>
                structuredClone(state.rows.find((r) => r.id === id)),
              insert: async (row) => {
                if (state.rows.some((r) => r.id === row.id))
                  throw new Error("duplicate");
                state.rows.push(structuredClone(row));
              },
              save: async (row, revision) => {
                const i = state.rows.findIndex(
                  (r) => r.id === row.id && r.revision === revision,
                );
                if (i < 0) return false;
                state.rows[i] = structuredClone(row);
                return true;
              },
              label: async (id) => (id === origin.id ? origin : undefined),
              profile: async (id) =>
                id === profile.id
                  ? { ...profile, revision: control.profileRevision }
                  : undefined,
              lockClaim: async (c) =>
                state.claim?.token === c.token &&
                state.claim.runtimeId === c.runtimeId &&
                Date.parse(state.claim.leaseExpiresAt) > Date.parse(control.now)
                  ? state.claim
                  : undefined,
              scheduleEvaluation: async (row) => {
                if (control.failSchedule) throw new Error("schedule failed");
                state.scheduled.push(row.id);
              },
              releaseClaim: async () => {
                state.claim = null;
              },
            },
            guard,
          ),
        );
      }),
  };
  const useCase = new RuleProposalGeneration(repository);
  const request = {
    sourceSnapshotId: snapshot.snapshotId,
    originLabelId: origin.id,
    profileId: profile.id,
  };
  const inspect = () =>
    foundation.withExtensions(actor.workspaceId, async (_base, ext) =>
      structuredClone(ext.proposals as State),
    );
  const claim = async (row: RuleProposal) =>
    foundation.withExtensions(actor.workspaceId, async (_base, ext) => {
      const state = ext.proposals as State,
        i = state.rows.findIndex((r) => r.id === row.id);
      state.rows[i] = {
        ...state.rows[i]!,
        status: "generating",
        revision: state.rows[i]!.revision + 1,
      };
      state.claim = ruleProposalClaimSchema.parse({
        workspaceId: actor.workspaceId,
        proposalId: row.id,
        runtimeId: "worker",
        token: "token",
        attempt: 1,
        leaseExpiresAt: at(22),
      });
      return structuredClone(state.claim);
    });
  const candidate = (row: RuleProposal): RuleCandidateResult => ({
    candidate: { ...snapshot.version, id: row.candidateId },
    rationale: "Review needed",
    destination: profile.destination,
    sourceSnapshotId: row.sourceSnapshotId,
    sourceInputHash: row.sourceInputHash,
    trainingCutoffAt: snapshot.lastDecisionAt,
    usage: { modelCalls: 1, outputTokens: 12 },
    reviewable: false,
  });
  return {
    actor,
    request,
    useCase,
    inspect,
    claim,
    candidate,
    control,
    repository,
  };
}
test("requests are scoped, idempotent and never reviewable before reports", async () => {
  const f = await setup(),
    row = await f.useCase.request(f.actor, f.request);
  assert.equal(row.status, "queued");
  assert.equal(row.generation, null);
  assert.deepEqual(await f.useCase.request(f.actor, f.request), row);
  assert.equal((await f.inspect()).rows.length, 1);
  await assert.rejects(
    f.useCase.request(f.actor, { ...f.request, profileId: "other" }),
    /different proposal/,
  );
  await assert.rejects(
    f.useCase.request({ ...f.actor, role: "viewer" }, f.request),
    /forbidden/,
  );
});
test("publication atomically stores candidate, enqueues evaluation and releases lease", async () => {
  const f = await setup(),
    row = await f.useCase.request(f.actor, f.request),
    claim = await f.claim(row);
  const input = await f.useCase.prepare(claim);
  assert.equal(input?.candidateId, row.candidateId);
  assert.equal(await f.useCase.complete(claim, f.candidate(row)), true);
  const state = await f.inspect();
  assert.equal(state.rows[0]?.status, "evaluating");
  assert.equal(state.rows[0]?.generation?.reviewable, false);
  assert.deepEqual(state.scheduled, [row.id]);
  assert.equal(state.claim, null);
  assert.equal(await f.useCase.complete(claim, f.candidate(row)), false);
});
test("enqueue failure rolls back candidate and claim release", async () => {
  const f = await setup(),
    row = await f.useCase.request(f.actor, f.request),
    claim = await f.claim(row);
  f.control.failSchedule = true;
  await assert.rejects(
    f.useCase.complete(claim, f.candidate(row)),
    /schedule failed/,
  );
  const state = await f.inspect();
  assert.equal(state.rows[0]?.status, "generating");
  assert.equal(state.rows[0]?.generation, null);
  assert.equal(state.claim?.token, claim.token);
  assert.equal(state.scheduled.length, 0);
});
test("expired or forged claims cannot publish or fail a newer worker's proposal", async () => {
  const f = await setup(),
    row = await f.useCase.request(f.actor, f.request),
    claim = await f.claim(row);
  assert.equal(
    await f.useCase.complete({ ...claim, token: "wrong" }, f.candidate(row)),
    false,
  );
  f.control.now = at(22);
  assert.equal(await f.useCase.failed(claim), false);
  assert.equal(await f.useCase.prepare(claim), undefined);
  assert.equal((await f.inspect()).rows[0]?.status, "generating");
});
test("changed profile authorization stops generation instead of publishing", async () => {
  const f = await setup(),
    row = await f.useCase.request(f.actor, f.request),
    claim = await f.claim(row);
  f.control.profileRevision++;
  assert.equal(await f.useCase.complete(claim, f.candidate(row)), false);
  const state = await f.inspect();
  assert.equal(state.rows[0]?.failure, "authorization_changed");
  assert.equal(state.scheduled.length, 0);
});
test("fixed severity and source cannot be changed through a worker result", async () => {
  const f = await setup(),
    row = await f.useCase.request(f.actor, f.request),
    claim = await f.claim(row),
    candidate = f.candidate(row);
  candidate.candidate.definition.severity = "critical";
  await assert.rejects(f.useCase.complete(claim, candidate), /fixed field/);
  assert.equal((await f.inspect()).rows[0]?.generation, null);
});
test("cancellation invalidates a live claim and caught transaction errors still roll back", async () => {
  const f = await setup(),
    row = await f.useCase.request(f.actor, f.request),
    claim = await f.claim(row);
  assert.equal((await f.useCase.cancel(f.actor, row.id)).status, "cancelled");
  assert.equal(await f.useCase.complete(claim, f.candidate(row)), false);
  await assert.rejects(
    f.repository.transaction(f.actor.workspaceId, async (tx) => {
      const prior = await tx.proposals.lock(row.id);
      assert.ok(prior);
      try {
        await tx.proposals.save(
          { ...prior, revision: prior.revision + 1, status: "queued" },
          prior.revision,
        );
      } catch {
        /* intentional */
      }
    }),
    /transition/,
  );
  assert.equal((await f.inspect()).rows[0]?.status, "cancelled");
});

test("optional fixed fields cannot be introduced in a worker result", async () => {
  const f = await setup(),
    row = await f.useCase.request(f.actor, f.request),
    claim = await f.claim(row),
    candidate = f.candidate(row);
  candidate.candidate.definition.collectionDelaySeconds = 60;
  await assert.rejects(f.useCase.complete(claim, candidate), /fixed field/);
  assert.equal((await f.inspect()).scheduled.length, 0);
});

test("a storage adapter cannot substitute a different generation attempt", async () => {
  const f = await setup(),
    row = await f.useCase.request(f.actor, f.request),
    claim = await f.claim(row);
  // This fixture deliberately returns its persisted claim even for a mismatched hint.
  await assert.rejects(
    f.useCase.complete({ ...claim, attempt: 2 }, f.candidate(row)),
  );
  const state = await f.inspect();
  assert.equal(state.rows[0]?.status, "generating");
  assert.equal(state.rows[0]?.generation, null);
  assert.deepEqual(state.scheduled, []);
  assert.equal(state.claim?.attempt, 1);
});
