import test from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import {
  workspaceIdSchema,
  serviceIdSchema,
  environmentIdSchema,
  type InvestigationSourceSelection,
} from "@bitsentry-escalator/features/contracts";
import {
  investigationSettingsSchema,
  investigationScopeSchema,
} from "@bitsentry-escalator/features/contracts";
import {
  RepositoryConnections,
  repositoryConnectionRevision,
  sameInvestigationConfiguration,
} from "@bitsentry-escalator/features/investigation";
import { investigationFixture } from "@escalator-test/investigation-fixture";
import { captureRepositorySources } from "../../src/platform/database/postgres-repository-capture.js";
import { standaloneInvestigationConfiguration } from "../../src/features/escalator/investigation/configuration.js";
const scope = {
  workspaceId: workspaceIdSchema.parse("org_a"),
  serviceId: serviceIdSchema.parse("api"),
  environmentId: environmentIdSchema.parse("prod"),
};
const connection = {
  scope,
  sourceId: "first",
  name: "API",
  targetId: "target",
  owner: "bitsentry-ai",
  repository: "api",
  secretId: "shared_key",
  enabled: true,
};
const selection = (sourceId: string): InvestigationSourceSelection => ({
  kind: "git_diff",
  sourceId,
  lookbackMs: 60000,
  limit: 5,
});
function database(
  rows: Array<{ id: string; revision: string; enabled: boolean }>,
) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    query: async (sql: string, values: unknown[]) => {
      calls.push({ sql, values });
      return { rows, rowCount: rows.length };
    },
  } as unknown as PoolClient;
  return { db, calls };
}
test("first-page repository capture reads target metadata once and only records opaque credential IDs", async () => {
  const second = { ...connection, sourceId: "second", repository: "worker" };
  const connections = new RepositoryConnections([connection, second]);
  const fake = database([{ id: "target", revision: "7", enabled: true }]);
  const captured = await captureRepositorySources(
    fake.db,
    scope,
    [selection("first"), selection("second"), selection("missing")],
    connections,
  );
  assert.deepEqual(captured.secretIds, ["shared_key"]);
  assert.deepEqual(captured.sourceVersions, [
    {
      kind: "git_diff",
      sourceId: "first",
      revision: repositoryConnectionRevision(connection, "7"),
    },
    {
      kind: "git_diff",
      sourceId: "second",
      revision: repositoryConnectionRevision(second, "7"),
    },
    { kind: "git_diff", sourceId: "missing", revision: "missing" },
  ]);
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.calls[0].values, ["org_a", "api", "prod", ["target"]]);
  assert.doesNotMatch(
    fake.calls[0].sql,
    /escalator_secret|FOR UPDATE|FOR SHARE/,
  );
});
test("native-only and cross-scope selections do not query repository metadata", async () => {
  const fake = database([]),
    connections = new RepositoryConnections([connection]);
  assert.deepEqual(
    await captureRepositorySources(
      fake.db,
      scope,
      [{ ...selection("first"), kind: "alert" }],
      connections,
    ),
    { sourceVersions: [], secretIds: [] },
  );
  assert.deepEqual(
    await captureRepositorySources(
      fake.db,
      { ...scope, environmentId: environmentIdSchema.parse("other") },
      [selection("first")],
      connections,
    ),
    {
      sourceVersions: [
        { kind: "git_diff", sourceId: "first", revision: "missing" },
      ],
      secretIds: [],
    },
  );
  assert.equal(fake.calls.length, 0);
});
test("disabled or removed targets capture an unavailable binding without approving its credential", async () => {
  for (const rows of [[], [{ id: "target", revision: "7", enabled: false }]]) {
    const fake = database(rows);
    assert.deepEqual(
      await captureRepositorySources(
        fake.db,
        scope,
        [selection("first")],
        new RepositoryConnections([connection]),
      ),
      {
        sourceVersions: [
          { kind: "git_diff", sourceId: "first", revision: "missing" },
        ],
        secretIds: [],
      },
    );
  }
});
test("a binding unavailable at capture and claim keeps the investigation without approving its credential", async () => {
  const sample = investigationFixture();
  const now = "2026-10-01T00:00:00.000Z";
  const settings = investigationSettingsSchema.parse({
    profile: {
      id: "profile",
      revision: 1,
      scope,
      destination: sample.result.report.destination,
      endpoint: "http://127.0.0.1:11434",
      secretId: null,
    },
    enabled: true,
    limits: sample.claim.limits,
    sources: [selection("first")],
    createdAt: now,
    updatedAt: now,
  });
  // The deploy target was disabled after the profile was saved.
  const target = { id: "target", revision: "7", enabled: false };
  const db = {
    query: async (sql: string) =>
      sql.includes("FROM escalator_investigation_settings s")
        ? { rows: [{ data: settings, sources: settings.sources }], rowCount: 1 }
        : sql.includes("FROM escalator_deploy_target")
          ? { rows: [target], rowCount: 1 }
          : { rows: [{ id: "present" }], rowCount: 1 },
  } as unknown as PoolClient;
  const connections = new RepositoryConnections([connection]);
  const captured = await captureRepositorySources(
    db,
    scope,
    settings.sources,
    connections,
  );
  const current = await standaloneInvestigationConfiguration(
    db,
    investigationScopeSchema.parse({ ...scope, incidentId: "incident" }),
    "profile",
    connections,
  );
  assert.deepEqual(current?.sourceVersions, captured.sourceVersions);
  assert.deepEqual(current?.secretIds, []);
  assert.equal(
    sameInvestigationConfiguration(
      { profile: settings.profile, ...captured },
      current,
    ),
    true,
  );
});
test("source count is bounded before any database work", async () => {
  const fake = database([]);
  await assert.rejects(
    captureRepositorySources(
      fake.db,
      scope,
      Array.from({ length: 33 }, (_, i) => selection(String(i))),
      new RepositoryConnections(),
    ),
  );
  assert.equal(fake.calls.length, 0);
});
