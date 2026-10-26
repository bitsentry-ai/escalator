import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { exportRule, importRule } from "../src/application/rules/export.js";
import { portableRuleSchema } from "../src/contracts/portable-rule.js";
import { detectionRuleSchema } from "../src/contracts/rules.js";
import { detectionRuleVersionSchema } from "../src/contracts/rule-state.js";
import {
  ruleCatalogEntrySchema,
  ruleTitleSchema,
} from "../src/contracts/rule-catalog.js";
import {
  workspaceIdSchema,
  responderIdSchema,
  type Actor,
} from "../src/contracts/identity.js";
import { fixture, at } from "./conformance/rule-backtest-fixture.js";
function source() {
  const version = fixture().version,
    d = version.definition;
  const entry = ruleCatalogEntrySchema.parse({
    id: version.id,
    workspaceId: d.workspaceId,
    serviceId: d.serviceId,
    environmentId: d.environmentId,
    title: "Availability",
    revision: 5,
    versionRevision: version.revision,
    generation: 2,
    status: "active",
    originProposalId: "original-proposal",
    createdAt: at(0),
    updatedAt: at(20),
  });
  return { version, entry };
}
const actor: Actor = {
  workspaceId: workspaceIdSchema.parse("destination"),
  responderId: responderIdSchema.parse("owner"),
  role: "administrator",
};
const mapping = {
  serviceId: "local-api",
  environmentId: "local-prod",
  streamId: "local-stream",
};
for (const kind of ["probe", "metric"] as const) {
  test(`portable ${kind} rule round-trips through import with explicit local mapping`, async () => {
    const f = source();
    const selector =
      kind === "probe"
        ? { kind, field: "failure", streamId: "old-stream" }
        : {
            kind,
            field: "error_rate",
            minimumRequests: 10,
            streamId: "old-stream",
          };
    const version = detectionRuleVersionSchema.parse({
      ...f.version,
      definition: {
        ...f.version.definition,
        selector,
        aggregation: "maximum",
      },
    });
    const exported = exportRule(f.entry, version);
    let importedDefinition: unknown;
    const entry = await importRule(
      {
        create: async (receivedActor, raw) => {
          assert.equal(receivedActor, actor);
          const input = z
            .strictObject({
              title: ruleTitleSchema,
              definition: detectionRuleSchema,
            })
            .parse(raw);
          importedDefinition = input.definition;
          return ruleCatalogEntrySchema.parse({
            ...f.entry,
            id: "fresh",
            workspaceId: actor.workspaceId,
            serviceId: mapping.serviceId,
            environmentId: mapping.environmentId,
            title: input.title,
            revision: 1,
            versionRevision: 1,
            generation: 0,
            status: "draft",
            originProposalId: null,
          });
        },
      },
      actor,
      JSON.parse(JSON.stringify(exported)),
      mapping,
    );
    assert.equal(entry.status, "draft");
    assert.equal(entry.originProposalId, null);
    assert.deepEqual(importedDefinition, {
      ...version.definition,
      workspaceId: actor.workspaceId,
      serviceId: mapping.serviceId,
      environmentId: mapping.environmentId,
      selector: { ...version.definition.selector, streamId: mapping.streamId },
    });
    const again = exportRule(
      entry,
      detectionRuleVersionSchema.parse({
        id: entry.id,
        revision: 1,
        definition: importedDefinition,
      }),
    );
    assert.deepEqual(again, exported);
  });
}
test("portable syntax contains no host IDs, activation state, secrets or proposal evidence", () => {
  const f = source(),
    document = exportRule(f.entry, f.version);
  const forbidden = new Set([
    "workspaceId",
    "serviceId",
    "environmentId",
    "streamId",
    "originProposalId",
    "secretId",
    "credentials",
    "generation",
    "status",
    "receiptId",
    "runId",
    "profileId",
  ]);
  function inspect(value: unknown) {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(forbidden.has(key), false, key);
      inspect(child);
    }
  }
  inspect(document);
  assert.throws(() =>
    portableRuleSchema.parse({ ...document, credentials: "not-portable" }),
  );
  assert.throws(() =>
    portableRuleSchema.parse({
      ...document,
      rule: { ...document.rule, status: "active" },
    }),
  );
  assert.throws(() =>
    portableRuleSchema.parse({ ...document, formatVersion: 2 }),
  );
});
test("import revalidates cross-field invariants before invoking local draft creation", () => {
  const f = source(),
    document = exportRule(f.entry, f.version);
  const drafts = {
    create: async (): Promise<never> => {
      throw new Error("must not write");
    },
  };
  assert.throws(
    () =>
      importRule(
        drafts,
        actor,
        { ...document, rule: { ...document.rule, windowSeconds: 61 } },
        mapping,
      ),
    /whole decision steps/,
  );
  assert.throws(() =>
    importRule(drafts, actor, document, { ...mapping, workspaceId: "foreign" }),
  );
});
test("export rejects a substituted catalog version or workspace", () => {
  const f = source();
  assert.throws(() => exportRule(f.entry, { ...f.version, revision: 2 }));
  assert.throws(() =>
    exportRule({ ...f.entry, workspaceId: actor.workspaceId }, f.version),
  );
});
test("import propagates the local authorization/source rejection", async () => {
  const f = source();
  await assert.rejects(
    importRule(
      {
        create: async (): Promise<never> => {
          throw new Error("local source unavailable");
        },
      },
      actor,
      exportRule(f.entry, f.version),
      mapping,
    ),
    /local source unavailable/,
  );
});
