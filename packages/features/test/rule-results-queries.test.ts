import test from "node:test";
import assert from "node:assert/strict";
import { MemoryFoundationRepository } from "./conformance/memory.js";
import { fixture, at } from "./conformance/rule-backtest-fixture.js";
import { workspaceSchema, responderSchema } from "../src/contracts/entities.js";
import { workspaceIdSchema, type Actor } from "../src/contracts/identity.js";
import {
  ruleReplayResultSchema,
  ruleProposalViewSchema,
} from "../src/contracts/rule-results.js";
import { RuleResultsQueries } from "../src/application/rules/results-queries.js";
import type {
  RuleResultsStore,
  RuleResultsRepository,
} from "../src/application/rules/results-ports.js";
async function setup() {
  const s = fixture(),
    d = s.version.definition,
    foundation = new MemoryFoundationRepository({
      now: () => new Date(at(21)),
    });
  const responder = responderSchema.parse({
    id: "reader",
    workspaceId: d.workspaceId,
    hostUserId: "local",
    displayName: "Reader",
    timeZone: "UTC",
    role: "viewer",
    enabled: true,
    createdAt: at(0),
    updatedAt: at(0),
  });
  const actor: Actor = {
    workspaceId: d.workspaceId,
    responderId: responder.id,
    role: responder.role,
  };
  await foundation.transaction(d.workspaceId, async (tx) => {
    await tx.workspace.insert(
      workspaceSchema.parse({
        id: d.workspaceId,
        name: "Rules",
        createdAt: at(0),
        updatedAt: at(0),
      }),
    );
    await tx.responders.insert(responder);
  });
  const row = ruleReplayResultSchema.parse({
    id: "run",
    workspaceId: d.workspaceId,
    snapshotId: s.snapshotId,
    version: s.version,
    firstDecisionAt: s.firstDecisionAt,
    lastDecisionAt: s.lastDecisionAt,
    createdAt: at(20),
    updatedAt: at(20),
    decisionCount: 0,
    proposalSource: true,
    state: "queued",
    report: null,
  });
  const proposal = ruleProposalViewSchema.parse({
    id: "proposal",
    workspaceId: d.workspaceId,
    serviceId: d.serviceId,
    environmentId: d.environmentId,
    candidateId: "candidate",
    originLabelId: "label",
    sourceSnapshotId: s.snapshotId,
    status: "queued",
    failure: null,
    heldOut: "required",
    fullRunId: null,
    heldOutRunId: null,
    createdAt: at(20),
    updatedAt: at(20),
    expiresAt: at(80),
    candidate: null,
    rationale: null,
  });
  const store: RuleResultsStore = {
    detail: async () => undefined,
    replays: async () => [row],
    replay: async (id) => (id === row.id ? row : undefined),
    proposals: async () => [proposal],
    proposal: async (id) => (id === proposal.id ? proposal : undefined),
  };
  const control = { disabled: false };
  const repository: RuleResultsRepository = {
    transaction: (scope, work) =>
      foundation.transaction(scope, (tx) =>
        work({
          ...tx,
          ruleResults: store,
          responders: {
            ...tx.responders,
            get: async (id) => {
              const r = await tx.responders.get(id);
              return r && control.disabled ? { ...r, enabled: false } : r;
            },
          },
        }),
      ),
  };
  return {
    queries: new RuleResultsQueries(repository),
    actor,
    control,
    store,
    row,
    proposal,
    d,
  };
}
test("viewers read scoped pending backtests and proposals without activation authority", async () => {
  const f = await setup(),
    input = { serviceId: f.d.serviceId, environmentId: f.d.environmentId };
  assert.equal(
    (await f.queries.replays(f.actor, input)).items[0].state,
    "queued",
  );
  assert.equal(
    (await f.queries.proposals(f.actor, { ...input, ruleId: "candidate" }))
      .items[0].candidate,
    null,
  );
  assert.equal(await f.queries.replay(f.actor, { id: "absent" }), undefined);
  assert.equal(
    (await f.queries.proposal(f.actor, { id: "proposal" }))?.id,
    "proposal",
  );
});
test("result readers reject stale roles and disabled responders", async () => {
  const f = await setup();
  await assert.rejects(
    f.queries.replay({ ...f.actor, role: "administrator" }, { id: "run" }),
    /forbidden/,
  );
  f.control.disabled = true;
  await assert.rejects(
    f.queries.proposal(f.actor, { id: "proposal" }),
    /forbidden/,
  );
});
test("list and detail reads reject substituted scope or record identity", async () => {
  const f = await setup(),
    foreign = workspaceIdSchema.parse("foreign");
  f.store.replay = async () => ({
    ...f.row,
    workspaceId: foreign,
    version: { ...f.row.version, definition: { ...f.d, workspaceId: foreign } },
  });
  await assert.rejects(f.queries.replay(f.actor, { id: "run" }));
  f.store.proposal = async () => ({ ...f.proposal, id: "other" });
  await assert.rejects(f.queries.proposal(f.actor, { id: "proposal" }));
  await assert.rejects(
    f.queries.replays(f.actor, {
      serviceId: "other",
      environmentId: f.d.environmentId,
    }),
  );
  await assert.rejects(
    f.queries.proposals(f.actor, {
      serviceId: f.d.serviceId,
      environmentId: "other",
    }),
  );
});
test("pagination returns at most the requested limit and preserves the cursor", async () => {
  const f = await setup();
  f.store.replays = async () => [f.row, { ...f.row, id: "second" }];
  const page = await f.queries.replays(f.actor, {
    serviceId: f.d.serviceId,
    environmentId: f.d.environmentId,
    limit: 1,
  });
  assert.equal(page.items.length, 1);
  assert.equal(page.next, "run");
  assert.throws(() =>
    f.queries.replays(f.actor, {
      serviceId: f.d.serviceId,
      environmentId: f.d.environmentId,
      limit: 26,
    }),
  );
});

test("report details require completed scoped evidence and current read authority", async () => {
  const f = await setup();
  let reads = 0;
  f.store.detail = async (input) => {
    reads++;
    return {
      workspaceId: f.actor.workspaceId,
      runId: input.runId,
      section: "episodes",
      items: [],
      next: null,
    };
  };
  assert.equal(
    await f.queries.detail(f.actor, { runId: "run", section: "episodes" }),
    undefined,
  );
  assert.equal(reads, 0);
  f.row.state = "completed";
  f.row.report = {
    status: "NOT_BACKTESTABLE",
    reason: "no_usable_history",
    simulation: {
      initialState: "inactive",
      warmupUntil: f.row.firstDecisionAt,
    },
    range: {
      firstDecisionAt: f.row.firstDecisionAt,
      lastDecisionAt: f.row.lastDecisionAt,
    },
    coverage: {
      totalDecisions: 1,
      evaluatedDecisions: 0,
      suppressedDecisions: 0,
      unknownDecisions: 1,
      fraction: 0,
    },
    episodeCount: 0,
    reviewedLabels: 0,
    unreviewedEpisodes: 0,
    ambiguousEpisodes: 0,
    truePositives: 0,
    falsePositives: 0,
    missedLabels: 0,
    unevaluableLabels: 0,
    precision: { value: null, denominator: 0, wilson95: null },
    labelCoverage: null,
  };
  assert.deepEqual(
    (await f.queries.detail(f.actor, { runId: "run", section: "episodes" }))
      ?.items,
    [],
  );
  f.store.detail = async () => ({
    workspaceId: f.actor.workspaceId,
    runId: "other",
    section: "episodes",
    items: [],
    next: null,
  });
  await assert.rejects(
    f.queries.detail(f.actor, { runId: "run", section: "episodes" }),
  );
  f.control.disabled = true;
  await assert.rejects(
    f.queries.detail(f.actor, { runId: "run", section: "episodes" }),
    /forbidden/,
  );
  assert.throws(() =>
    f.queries.detail(f.actor, { runId: "run", section: "episodes", limit: 26 }),
  );
});
