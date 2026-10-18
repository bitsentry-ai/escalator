import test from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import {
  investigationScopeSchema,
  evidenceQuerySchema,
} from "@bitsentry-escalator/features/contracts";
import {
  RepositoryConnections,
  repositoryConnectionRevision,
  repositoryConnectionSchema,
} from "@bitsentry-escalator/features/investigation";
import {
  readRepositoryBinding,
  readRepositoryComparison,
} from "../../src/platform/database/postgres-repository-evidence.js";
const scope = investigationScopeSchema.parse({
  workspaceId: "org_a",
  serviceId: "api",
  environmentId: "prod",
  incidentId: "incident",
});
const connection = repositoryConnectionSchema.parse({
  scope: { workspaceId: "org_a", serviceId: "api", environmentId: "prod" },
  sourceId: "repository",
  targetId: "target",
  name: "API source",
  owner: "bitsentry-ai",
  repository: "api",
  secretId: null,
  enabled: true,
});
function database(replies: Array<Array<Record<string, unknown>>>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      const rows = replies.shift();
      assert.ok(rows, "unexpected database call");
      return { rows, rowCount: rows.length };
    },
  } as unknown as PoolClient;
  return { db, calls };
}
test("absent, disabled and cross-scope repository connections never request target or secret metadata", async () => {
  const fake = database([]);
  const connections = new RepositoryConnections([connection]);
  for (const input of [
    investigationScopeSchema.parse({ ...scope, serviceId: "other" }),
    investigationScopeSchema.parse({ ...scope, environmentId: "other" }),
    investigationScopeSchema.parse({ ...scope, workspaceId: "org_b" }),
  ])
    assert.equal(
      await readRepositoryBinding(fake.db, input, "repository", connections),
      undefined,
    );
  assert.equal(
    await readRepositoryBinding(fake.db, scope, "missing", connections),
    undefined,
  );
  assert.equal(
    await readRepositoryBinding(
      fake.db,
      scope,
      "repository",
      new RepositoryConnections([{ ...connection, enabled: false }]),
    ),
    undefined,
  );
  assert.equal(fake.calls.length, 0);
});
test("public repository metadata binds an enabled target and its revision without reading any secret", async () => {
  const fake = database([[{ revision: "7", enabled: true }]]);
  const value = await readRepositoryBinding(
    fake.db,
    scope,
    "repository",
    new RepositoryConnections([connection]),
  );
  assert.equal(value?.revision, repositoryConnectionRevision(connection, "7"));
  assert.deepEqual(fake.calls[0].params, ["org_a", "target", "api", "prod"]);
  assert.equal(fake.calls.length, 1);
});
test("missing or disabled targets cannot authorize an otherwise configured repository", async () => {
  for (const rows of [[], [{ revision: "7", enabled: false }]]) {
    const fake = database([rows]);
    assert.equal(
      await readRepositoryBinding(
        fake.db,
        scope,
        "repository",
        new RepositoryConnections([connection]),
      ),
      undefined,
    );
    assert.equal(fake.calls.length, 1);
  }
});
test("private connections request only their configured workspace-scoped opaque secret", async () => {
  const privateConnection = { ...connection, secretId: "repo_pat" };
  const fake = database([
    [{ revision: "7", enabled: true }],
    [{ id: "repo_pat" }],
  ]);
  const value = await readRepositoryBinding(
    fake.db,
    scope,
    "repository",
    new RepositoryConnections([privateConnection]),
  );
  assert.deepEqual(value?.connection, privateConnection);
  assert.deepEqual(fake.calls[1].params, ["org_a", "repo_pat"]);
  assert.equal(fake.calls.length, 2);
});
test("an unavailable credential denies a private connection before provider access", async () => {
  const fake = database([[{ revision: "7", enabled: true }], []]);
  assert.equal(
    await readRepositoryBinding(
      fake.db,
      scope,
      "repository",
      new RepositoryConnections([{ ...connection, secretId: "revoked" }]),
    ),
    undefined,
  );
});
test("comparison selection rejects a different source or environment before a database read", async () => {
  const fake = database([]);
  const query = evidenceQuerySchema.parse({
    kind: "git_diff",
    sourceId: "other",
    window: {
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-10-01T01:00:00.000Z",
    },
    limit: 5,
  });
  assert.equal(
    await readRepositoryComparison(
      fake.db,
      scope,
      query,
      connection,
      "2026-10-01T02:00:00.000Z",
    ),
    undefined,
  );
  assert.equal(
    await readRepositoryComparison(
      fake.db,
      investigationScopeSchema.parse({ ...scope, environmentId: "other" }),
      { ...query, sourceId: "repository" },
      connection,
      "2026-10-01T02:00:00.000Z",
    ),
    undefined,
  );
  assert.equal(fake.calls.length, 0);
});
