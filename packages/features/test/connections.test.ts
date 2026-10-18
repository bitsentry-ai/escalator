import test from "node:test";
import assert from "node:assert/strict";
import {
  RepositoryConnections,
  repositoryConnectionSchema,
  repositoryConnectionRevision,
} from "../src/investigation/evidence/connections.js";
import { investigationSourceOptionsInputSchema } from "../src/contracts/index.js";
const connection = () =>
  repositoryConnectionSchema.parse({
    scope: { workspaceId: "org_a", serviceId: "api", environmentId: "prod" },
    sourceId: "github",
    name: "API repository",
    targetId: "deploy_target",
    owner: "bitsentry-ai",
    repository: "api",
    secretId: "opaque_secret",
    enabled: true,
  });
const query = (limit = 50, after?: string) =>
  investigationSourceOptionsInputSchema.parse({
    serviceId: "api",
    environmentId: "prod",
    kind: "git_diff",
    limit,
    after,
  });
test("empty host configuration cannot discover or authorize a repository", () => {
  const catalog = new RepositoryConnections();
  const value = connection();
  assert.equal(catalog.get(value.scope, value.sourceId), undefined);
  assert.deepEqual(catalog.list(value.scope.workspaceId, query()), {
    items: [],
    next: null,
  });
});
test("catalog projects source choices without exposing credential or target bindings", () => {
  const value = connection();
  const catalog = new RepositoryConnections([value]);
  assert.deepEqual(catalog.list(value.scope.workspaceId, query()), {
    items: [
      {
        kind: "git_diff",
        sourceId: "github",
        name: "API repository",
        enabled: true,
      },
    ],
    next: null,
  });
  assert.doesNotMatch(
    JSON.stringify(catalog.list(value.scope.workspaceId, query())),
    /opaque_secret|deploy_target|bitsentry-ai/,
  );
});
test("connections remain isolated by workspace, service and environment", () => {
  const value = connection();
  const catalog = new RepositoryConnections([value]);
  for (const key of ["workspaceId", "serviceId", "environmentId"] as const) {
    const other = repositoryConnectionSchema.parse({
      ...value,
      scope: { ...value.scope, [key]: "other" },
    });
    assert.equal(catalog.get(other.scope, value.sourceId), undefined);
    const input = investigationSourceOptionsInputSchema.parse({
      ...query(),
      serviceId: other.scope.serviceId,
      environmentId: other.scope.environmentId,
    });
    assert.deepEqual(catalog.list(other.scope.workspaceId, input), {
      items: [],
      next: null,
    });
  }
});
test("source identifiers are unique within a workspace even across placements", () => {
  const value = connection();
  assert.throws(() => new RepositoryConnections([value, value]));
  assert.throws(
    () =>
      new RepositoryConnections([
        value,
        { ...value, scope: { ...value.scope, serviceId: "other" } },
      ]),
  );
  const other = repositoryConnectionSchema.parse({
    ...value,
    scope: { ...value.scope, workspaceId: "org_b" },
  });
  const catalog = new RepositoryConnections([value, other]);
  assert.deepEqual(catalog.get(other.scope, other.sourceId), other);
});
test("operator input and returned objects cannot mutate the immutable catalog", () => {
  const value = connection();
  const catalog = new RepositoryConnections([value]);
  value.owner = "changed";
  value.scope.serviceId = "changed" as typeof value.scope.serviceId;
  const original = connection();
  const returned = catalog.get(original.scope, original.sourceId)!;
  returned.secretId = "another_secret";
  returned.scope.environmentId =
    "changed" as typeof returned.scope.environmentId;
  assert.deepEqual(catalog.get(original.scope, original.sourceId), original);
});
test("disabled connections remain visibly disabled and do not disappear from audit choices", () => {
  const value = { ...connection(), enabled: false };
  const catalog = new RepositoryConnections([value]);
  assert.equal(
    catalog.list(value.scope.workspaceId, query()).items[0]!.enabled,
    false,
  );
  assert.equal(catalog.get(value.scope, value.sourceId)!.enabled, false);
});
test("cursor pagination uses stable opaque IDs and no cross-kind fallback", () => {
  const original = connection();
  const catalog = new RepositoryConnections(
    ["z", "A", "a"].map((sourceId) => ({ ...original, sourceId })),
  );
  const first = catalog.list(original.scope.workspaceId, query(2));
  assert.deepEqual(
    first.items.map((value) => value.sourceId),
    ["A", "a"],
  );
  assert.equal(first.next, "a");
  const next = catalog.list(original.scope.workspaceId, query(2, first.next!));
  assert.deepEqual(
    next.items.map((value) => value.sourceId),
    ["z"],
  );
  assert.equal(next.next, null);
  assert.deepEqual(
    catalog.list(original.scope.workspaceId, {
      ...query(),
      kind: "deployment",
    }),
    { items: [], next: null },
  );
});
test("connection and target edits change the captured revision without a manual version counter", () => {
  const value = connection();
  const baseline = repositoryConnectionRevision(value, "1");
  assert.match(baseline, /^[a-f0-9]{64}$/);
  assert.equal(
    baseline,
    repositoryConnectionRevision(structuredClone(value), "1"),
  );
  for (const change of [
    { owner: "another" },
    { repository: "other" },
    { targetId: "other" },
    { secretId: "other" },
    { secretId: null },
    { enabled: false },
    { scope: { ...value.scope, serviceId: "other" } },
  ]) {
    const edited = repositoryConnectionSchema.parse({ ...value, ...change });
    assert.notEqual(repositoryConnectionRevision(edited, "1"), baseline);
  }
  assert.notEqual(repositoryConnectionRevision(value, "2"), baseline);
  assert.throws(() => repositoryConnectionRevision(value, "bad/revision"));
});
test("strict bounded configuration rejects embedded credentials and arbitrary endpoints", () => {
  for (const extra of [
    { token: "never-retain" },
    { endpoint: "http://localhost" },
    { revision: 1 },
  ])
    assert.throws(
      () => new RepositoryConnections([{ ...connection(), ...extra }]),
    );
  assert.throws(
    () =>
      new RepositoryConnections(
        Array.from({ length: 257 }, (_, i) => ({
          ...connection(),
          sourceId: `source-${i}`,
        })),
      ),
  );
  assert.throws(
    () =>
      new RepositoryConnections([
        { ...connection(), secretId: "https://example.com/token" },
      ]),
  );
  assert.doesNotThrow(
    () => new RepositoryConnections([{ ...connection(), secretId: null }]),
  );
});
