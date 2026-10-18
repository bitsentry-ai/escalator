import test from "node:test";
import assert from "node:assert/strict";
import { ruleCatalogEntrySchema } from "../src/contracts/rule-catalog.js";
import {
  encodeRuleCatalogData,
  decodeRuleCatalogData,
} from "../src/application/rules/catalog-storage.js";
import { withRuleCatalog } from "../src/application/rules/catalog-transaction.js";
import type { RuleCatalogStore } from "../src/application/rules/activation-ports.js";
import { MemoryFoundationRepository } from "./conformance/memory.js";
import { fixture, at } from "./conformance/rule-backtest-fixture.js";
const version = fixture().version,
  scope = version.definition.workspaceId;
function entry() {
  return ruleCatalogEntrySchema.parse({
    id: version.id,
    workspaceId: scope,
    serviceId: version.definition.serviceId,
    environmentId: version.definition.environmentId,
    title: "Candidate",
    revision: 1,
    versionRevision: 1,
    generation: 0,
    status: "draft",
    originProposalId: null,
    createdAt: at(0),
    updatedAt: at(0),
  });
}
test("catalog payloads omit tenant keys and regain only the database transaction scope", () => {
  const raw = JSON.parse(encodeRuleCatalogData(scope, "catalog", entry()));
  assert.equal(Object.hasOwn(raw, "workspaceId"), false);
  assert.deepEqual(decodeRuleCatalogData(scope, "catalog", raw), entry());
  assert.throws(
    () =>
      decodeRuleCatalogData(scope, "catalog", { ...raw, workspaceId: scope }),
    /scope_violation/,
  );
  assert.throws(
    () =>
      encodeRuleCatalogData(scope, "catalog", {
        ...entry(),
        workspaceId: "other" as typeof scope,
      }),
    /scope_violation/,
  );
});
const unexpected = async () => {
  throw new Error("Injected catalog failure");
};
function store(): RuleCatalogStore {
  return {
    currentTime: async () => at(1),
    lockDefinition: unexpected,
    lock: unexpected,
    version: unexpected,
    latestVersionRevision: unexpected,
    insert: unexpected,
    insertVersion: unexpected,
    save: unexpected,
    runtime: unexpected,
    retireRuntime: unexpected,
    activateRuntime: unexpected,
    review: unexpected,
    insertReview: unexpected,
    history: unexpected,
    evidence: unexpected,
  };
}
test("catching a failed catalog primitive cannot permit commit", async () => {
  const foundation = new MemoryFoundationRepository({
    now: () => new Date(at(10)),
  });
  await assert.rejects(
    foundation.withExtensions(scope, async (base, _extensions, guard) => {
      const tx = withRuleCatalog(base, store(), guard);
      await assert.rejects(
        tx.catalog.insertVersion(version),
        /Injected catalog failure/,
      );
    }),
    /Injected catalog failure/,
  );
});
test("catalog handles expire with their enclosing physical transaction", async () => {
  const foundation = new MemoryFoundationRepository({
    now: () => new Date(at(10)),
  });
  const catalog = await foundation.withExtensions(
    scope,
    async (base, _extensions, guard) =>
      withRuleCatalog(base, store(), guard).catalog,
  );
  await assert.rejects(catalog.currentTime(), /closed_transaction/);
});
