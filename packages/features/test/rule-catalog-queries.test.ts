import test from "node:test";
import assert from "node:assert/strict";
import { MemoryFoundationRepository } from "./conformance/memory.js";
import { fixture, at } from "./conformance/rule-backtest-fixture.js";
import { workspaceSchema, responderSchema } from "../src/contracts/entities.js";
import { workspaceIdSchema, type Actor } from "../src/contracts/identity.js";
import {
  ruleCatalogEntrySchema,
  ruleActivationHistorySchema,
} from "../src/contracts/rule-catalog.js";
import { RuleCatalogQueries } from "../src/application/rules/catalog-queries.js";
import type {
  RuleCatalogReadRepository,
  RuleCatalogReadStore,
} from "../src/application/rules/catalog-read-ports.js";
async function setup() {
  const version = fixture().version,
    d = version.definition;
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
  const foundation = new MemoryFoundationRepository({
    now: () => new Date(at(21)),
  });
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
  const entries = ["alpha", "beta"].map((id) =>
    ruleCatalogEntrySchema.parse({
      id,
      workspaceId: d.workspaceId,
      serviceId: d.serviceId,
      environmentId: d.environmentId,
      title: id,
      revision: 2,
      versionRevision: 1,
      generation: 0,
      status: "retired",
      originProposalId: null,
      createdAt: at(0),
      updatedAt: at(20),
    }),
  );
  const history = [2, 1].map((revision) =>
    ruleActivationHistorySchema.parse({
      id: `history-${revision}`,
      workspaceId: d.workspaceId,
      ruleId: "alpha",
      catalogRevision: revision,
      versionRevision: 1,
      generation: 0,
      action: revision === 1 ? "drafted" : "retired",
      actorId: responder.id,
      previousVersionRevision: revision === 1 ? null : 1,
      previousIncidentId: null,
      receiptId: null,
      recordedAt: at(revision),
    }),
  );
  const control = { revoked: false, reads: 0 };
  const store: RuleCatalogReadStore = {
    list: async (input) => {
      control.reads++;
      return entries
        .filter((r) => !input.after || r.id > input.after)
        .slice(0, input.limit + 1);
    },
    get: async (id) => {
      control.reads++;
      const entry = entries.find((r) => r.id === id);
      return entry ? { entry, version: { ...version, id } } : undefined;
    },
    history: async (input) => {
      control.reads++;
      return history
        .filter(
          (r) =>
            r.ruleId === input.ruleId &&
            (!input.afterRevision || r.catalogRevision < input.afterRevision),
        )
        .slice(0, input.limit + 1);
    },
  };
  const repository: RuleCatalogReadRepository = {
    transaction: (scope, work) =>
      foundation.transaction(scope, (tx) =>
        work({
          ...tx,
          catalogRead: store,
          responders: {
            ...tx.responders,
            get: async (id) => {
              const row = await tx.responders.get(id);
              return row && control.revoked ? { ...row, enabled: false } : row;
            },
          },
        }),
      ),
  };
  return {
    queries: new RuleCatalogQueries(repository),
    actor,
    control,
    store,
    entries,
    d,
  };
}
test("viewers can paginate scoped rules without activation authority", async () => {
  const f = await setup(),
    input = {
      serviceId: f.d.serviceId,
      environmentId: f.d.environmentId,
      limit: 1,
    };
  const first = await f.queries.list(f.actor, input);
  assert.deepEqual(
    first.items.map((r) => r.id),
    ["alpha"],
  );
  assert.equal(first.next, "alpha");
  const second = await f.queries.list(f.actor, { ...input, after: first.next });
  assert.deepEqual(
    second.items.map((r) => r.id),
    ["beta"],
  );
  assert.equal(second.next, null);
});
test("catalog details retain their immutable version binding and export only portable fields", async () => {
  const f = await setup(),
    view = await f.queries.get(f.actor, { id: "alpha" });
  assert.equal(view?.version.id, "alpha");
  assert.equal(view?.entry.status, "retired");
  const document = await f.queries.export(f.actor, { id: "alpha" });
  assert.equal(document.title, "alpha");
  assert.equal("workspaceId" in document.rule, false);
  assert.equal(await f.queries.get(f.actor, { id: "missing" }), undefined);
});
test("history uses a descending catalog revision cursor", async () => {
  const f = await setup(),
    first = await f.queries.history(f.actor, { ruleId: "alpha", limit: 1 });
  assert.equal(first.items[0].catalogRevision, 2);
  assert.equal(first.next, 2);
  const last = await f.queries.history(f.actor, {
    ruleId: "alpha",
    afterRevision: first.next,
    limit: 1,
  });
  assert.equal(last.items[0].catalogRevision, 1);
  assert.equal(last.next, null);
});
test("revoked and stale roles cannot read persisted rules", async () => {
  const f = await setup();
  f.control.revoked = true;
  await assert.rejects(f.queries.get(f.actor, { id: "alpha" }), /forbidden/);
  f.control.revoked = false;
  await assert.rejects(
    f.queries.get({ ...f.actor, role: "administrator" }, { id: "alpha" }),
    /forbidden/,
  );
  assert.equal(f.control.reads, 0);
});
test("reader rejects substituted tenant or service data", async () => {
  const f = await setup(),
    foreign = workspaceIdSchema.parse("foreign");
  f.store.get = async () => ({
    entry: { ...f.entries[0], workspaceId: foreign },
    version: {
      ...fixture().version,
      id: "alpha",
      definition: { ...f.d, workspaceId: foreign },
    },
  });
  await assert.rejects(f.queries.get(f.actor, { id: "alpha" }));
  await assert.rejects(
    f.queries.list(f.actor, {
      serviceId: "other",
      environmentId: f.d.environmentId,
    }),
  );
});
test("reader enforces page bounds before repository access", async () => {
  const f = await setup();
  assert.throws(() =>
    f.queries.list(f.actor, {
      serviceId: f.d.serviceId,
      environmentId: f.d.environmentId,
      limit: 51,
    }),
  );
  assert.equal(f.control.reads, 0);
});
