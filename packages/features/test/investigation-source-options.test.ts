import test from "node:test";
import assert from "node:assert/strict";
import {
  workspaceIdSchema,
  responderIdSchema,
  serviceIdSchema,
  environmentIdSchema,
  type Actor,
} from "../src/contracts/identity.js";
import {
  listInvestigationSources,
  type InvestigationSourceCatalog,
} from "../src/application/investigation-settings/source-options.js";
const actor: Actor = {
  workspaceId: workspaceIdSchema.parse("workspace_a"),
  responderId: responderIdSchema.parse("viewer"),
  role: "viewer",
};
const input = {
  serviceId: serviceIdSchema.parse("service_a"),
  environmentId: environmentIdSchema.parse("environment_a"),
  kind: "alert" as const,
  limit: 2,
};
const item = (sourceId: string) => ({
  kind: "alert" as const,
  sourceId,
  name: sourceId,
  enabled: true,
});
test("source catalog uses the trusted workspace and preserves bounded per-kind pagination", async () => {
  const catalog: InvestigationSourceCatalog = {
    list: async (scope, query) => {
      assert.equal(scope, actor.workspaceId);
      assert.deepEqual(query, input);
      return { items: [item("source_a"), item("source_b")], next: "source_b" };
    },
  };
  assert.equal(
    (await listInvestigationSources(actor, input, catalog)).next,
    "source_b",
  );
});
test("catalog rejects injected scope, excessive limits and invalid returned pages", async () => {
  const unused: InvestigationSourceCatalog = {
    list: async () => assert.fail("catalog queried for invalid input"),
  };
  await assert.rejects(
    listInvestigationSources(
      actor,
      { ...input, workspaceId: "other" } as never,
      unused,
    ),
  );
  await assert.rejects(
    listInvestigationSources(actor, { ...input, limit: 101 }, unused),
  );
  for (const page of [
    { items: [item("b"), item("a")], next: null },
    { items: [item("a"), item("a")], next: null },
    { items: [item("a")], next: "other" },
    { items: [{ ...item("a"), kind: "metric" as const }], next: null },
    { items: [item("a"), item("b"), item("c")], next: null },
  ])
    await assert.rejects(
      listInvestigationSources(actor, input, { list: async () => page }),
    );
  await assert.rejects(
    listInvestigationSources(
      actor,
      { ...input, after: "b" },
      { list: async () => ({ items: [item("a")], next: null }) },
    ),
  );
});
