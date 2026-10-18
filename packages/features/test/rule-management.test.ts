import { RuleRequestError } from "../src/application/rules/request-error.js";
import test from "node:test";
import assert from "node:assert/strict";
import { fixture, at } from "./conformance/rule-backtest-fixture.js";
import { ruleCatalogEntrySchema } from "../src/contracts/rule-catalog.js";
import { ruleReplayRunSchema } from "../src/contracts/replay-run.js";
import { responderIdSchema, type Actor } from "../src/contracts/identity.js";
import { createRuleDraftSchema } from "../src/contracts/rule-management.js";
import { RuleManagement } from "../src/application/rules/management.js";
import { ruleRequestFailure } from "../src/application/rules/request-error.js";
function setup() {
  const s = fixture(),
    definition = s.version.definition;
  const actor: Actor = {
    workspaceId: definition.workspaceId,
    responderId: responderIdSchema.parse("owner"),
    role: "administrator",
  };
  const entry = ruleCatalogEntrySchema.parse({
    id: s.version.id,
    workspaceId: actor.workspaceId,
    serviceId: definition.serviceId,
    environmentId: definition.environmentId,
    title: "Availability",
    revision: 2,
    versionRevision: 1,
    generation: 0,
    status: "draft",
    originProposalId: null,
    createdAt: at(0),
    updatedAt: at(1),
  });
  const calls: { actor: Actor; raw: unknown }[] = [],
    captures: unknown[] = [];
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected operation");
  };
  const management = new RuleManagement(
    {
      list: unexpected,
      get: async () => ({ entry, version: s.version }),
      history: unexpected,
      export: unexpected,
    },
    {
      create: async (actor, raw) => {
        calls.push({ actor, raw });
        return entry;
      },
      edit: async (actor, raw) => {
        calls.push({ actor, raw });
        return entry;
      },
      adopt: unexpected,
    },
    { review: unexpected, activate: unexpected, retire: unexpected },
    {
      create: async (actor, version, range) => {
        captures.push({ actor, version, range });
        return ruleReplayRunSchema.parse({
          id: "run",
          workspaceId: actor.workspaceId,
          snapshotId: "snapshot",
          inputHash: "a".repeat(64),
          revision: 1,
          status: "queued",
          nextBatch: 0,
          cursor: null,
          decisionCount: 0,
          createdAt: at(20),
          updatedAt: at(20),
        });
      },
    },
    { request: unexpected },
    {
      detail: unexpected,
      replays: unexpected,
      replay: unexpected,
      proposals: unexpected,
      proposal: unexpected,
    },
  );
  const { workspaceId, ...local } = definition;
  void workspaceId;
  return { management, actor, entry, local, calls, captures, s };
}
test("manual rule inputs bind the host tenant and revalidate the evaluator", async () => {
  const f = setup();
  await f.management.create(f.actor, {
    title: "Availability",
    definition: f.local,
  });
  assert.equal(
    (f.calls[0].raw as { definition: { workspaceId: string } }).definition
      .workspaceId,
    f.actor.workspaceId,
  );
  assert.throws(() =>
    f.management.create(f.actor, {
      title: "Bad",
      definition: { ...f.local, workspaceId: "foreign" },
    }),
  );
  assert.throws(() =>
    f.management.create(f.actor, {
      title: "Bad",
      definition: { ...f.local, windowSeconds: 61 },
    }),
  );
  assert.equal(f.calls.length, 1);
});
test("capture loads the immutable server version and never accepts supplied evidence", async () => {
  const f = setup(),
    input = {
      ruleId: f.entry.id,
      expectedRevision: 2,
      firstDecisionAt: at(1),
      lastDecisionAt: at(10),
    };
  assert.deepEqual(await f.management.replay(f.actor, input), {
    id: "run",
    snapshotId: "snapshot",
  });
  assert.deepEqual(f.captures[0], {
    actor: f.actor,
    version: f.s.version,
    range: { firstDecisionAt: at(1), lastDecisionAt: at(10) },
  });
  await assert.rejects(
    f.management.replay(f.actor, { ...input, coverage: [] }),
  );
  await assert.rejects(
    f.management.replay(f.actor, { ...input, expectedRevision: 1 }),
    /changed concurrently/,
  );
  assert.equal(f.captures.length, 1);
});
test("transport errors redact validation contents and unknown infrastructure details", () => {
  const parsed = createRuleDraftSchema.safeParse({
    privateEndpoint: "https://private.invalid",
  });
  assert.equal(parsed.success, false);
  if (!parsed.success)
    assert.deepEqual(ruleRequestFailure(parsed.error), {
      code: "BAD_REQUEST",
      message: "Invalid rule request",
    });
  assert.equal(
    ruleRequestFailure(new Error("Rule approval forbidden")),
    undefined,
  );
  assert.equal(
    ruleRequestFailure(new Error("password=private database details")),
    undefined,
  );
  assert.equal(
    ruleRequestFailure(
      new RuleRequestError("CONFLICT", "diagnostic wording changed"),
    )?.code,
    "CONFLICT",
  );
  assert.equal(
    ruleRequestFailure(new RuleRequestError("FORBIDDEN", "another diagnostic"))
      ?.code,
    "FORBIDDEN",
  );
});
