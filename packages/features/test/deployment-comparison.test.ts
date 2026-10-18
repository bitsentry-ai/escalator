import test from "node:test";
import assert from "node:assert/strict";
import { repositoryComparisonFromDeployments } from "../src/investigation/evidence/deployment-comparison.js";
import { repositoryConnectionSchema } from "../src/investigation/evidence/connections.js";
import { GithubDiffError } from "../src/investigation/evidence/github-http.js";
import {
  investigationScopeSchema,
  evidenceQuerySchema,
} from "../src/contracts/index.js";
const scope = investigationScopeSchema.parse({
  workspaceId: "org_a",
  serviceId: "api",
  environmentId: "prod",
  incidentId: "incident",
});
const connection = repositoryConnectionSchema.parse({
  scope: { workspaceId: "org_a", serviceId: "api", environmentId: "prod" },
  sourceId: "github",
  name: "API",
  targetId: "target",
  owner: "bitsentry-ai",
  repository: "api",
  secretId: null,
  enabled: true,
});
const query = evidenceQuerySchema.parse({
  kind: "git_diff",
  sourceId: "github",
  window: { from: "2026-10-01T00:30:00.000Z", to: "2026-10-01T01:00:00.000Z" },
  limit: 5,
});
const asOf = "2026-10-01T01:05:00.000Z";
const head = () => ({
  targetId: "target",
  record: {
    id: "head",
    workspaceId: "org_a",
    serviceId: "api",
    environmentId: "prod",
    source: "ci",
    externalId: "run",
    actor: "deployer",
    commit: "b".repeat(40),
    artifact: null,
    tokenId: "grant",
    mappedDeployerId: null,
    startedAt: "2026-10-01T01:00:00.000Z",
    acceptedAt: "2026-10-01T01:00:01.000Z",
    timeoutAt: "2026-10-01T01:30:00.000Z",
    updatedAt: "2026-10-01T01:00:01.000Z",
    status: "STARTED",
    revision: 1,
    timedOutAt: null,
    finish: null as null | {
      outcome: string;
      actor: string;
      occurredAt: string;
      receivedAt: string;
    },
  },
});
const base = () => ({
  targetId: "target",
  record: {
    ...head().record,
    id: "base",
    commit: "a".repeat(40),
    startedAt: "2026-10-01T00:00:00.000Z",
    acceptedAt: "2026-10-01T00:00:01.000Z",
    timeoutAt: "2026-10-01T00:30:00.000Z",
    updatedAt: "2026-10-01T00:10:01.000Z",
    status: "SUCCEEDED",
    revision: 2,
    finish: {
      outcome: "SUCCEEDED",
      actor: "deployer",
      occurredAt: "2026-10-01T00:10:00.000Z",
      receivedAt: "2026-10-01T00:10:01.000Z",
    },
  },
});
const prepare = (current: unknown = head(), previous: unknown = base()) =>
  repositoryComparisonFromDeployments(
    scope,
    query,
    connection,
    current,
    previous,
    asOf,
  );
const reason = (expected: string) => (error: unknown) =>
  error instanceof GithubDiffError && error.reason === expected;
test("immutable SHAs come from the exact scoped target's current and previous successful deployment", () => {
  const result = prepare();
  assert.deepEqual(result.scope, scope);
  assert.equal(result.sourceId, "github");
  assert.equal(result.baseSha, "a".repeat(40));
  assert.equal(result.headSha, "b".repeat(40));
  assert.equal(result.observedAt, head().record.startedAt);
  assert.equal(result.deploymentReceivedAt, head().record.acceptedAt);
  assert.doesNotMatch(JSON.stringify(result), /grant|deployer/);
});
test("missing predecessor or head cannot be replaced with a branch name or guessed baseline", () => {
  assert.throws(() => prepare(undefined, null), reason("not_found"));
  assert.throws(() => prepare(null, base()), reason("not_found"));
});
test("cross-target and cross-environment history is not usable evidence", () => {
  const wrong = head();
  wrong.targetId = "other";
  assert.throws(() => prepare(wrong), reason("not_authorized"));
  const wrongScope = base();
  wrongScope.record.environmentId = "other";
  assert.throws(() => prepare(head(), wrongScope), reason("not_authorized"));
});
test("a late-arriving finish cannot become a hindsight baseline", () => {
  const previous = base();
  previous.record.finish.receivedAt = "2026-10-01T01:01:00.000Z";
  previous.record.updatedAt = previous.record.finish.receivedAt;
  assert.throws(() => prepare(head(), previous), reason("invalid_response"));
});
test("a deployment that completed after the next start is not that start's prior successful baseline", () => {
  const previous = base();
  previous.record.finish.occurredAt = "2026-10-01T01:00:00.500Z";
  previous.record.finish.receivedAt = "2026-10-01T01:00:00.600Z";
  previous.record.updatedAt = previous.record.finish.receivedAt;
  assert.throws(() => prepare(head(), previous), reason("invalid_response"));
});
test("a failed predecessor and a deployment paired with itself cannot form a baseline", () => {
  const previous = base();
  previous.record.status = "FAILED";
  previous.record.finish.outcome = "FAILED";
  assert.throws(() => prepare(head(), previous), reason("invalid_response"));
  const same = base();
  same.record.id = "head";
  assert.throws(() => prepare(head(), same), reason("invalid_response"));
});
test("symbolic or abbreviated commit identifiers are not sent to GitHub", () => {
  for (const commit of ["main", "abc123"]) {
    const current = head();
    current.record.commit = commit;
    assert.throws(() => prepare(current), reason("invalid_configuration"));
  }
});
test("a future head receipt and an event outside the requested window are rejected", () => {
  const current = head();
  current.record.acceptedAt = "2026-10-01T02:00:00.000Z";
  current.record.updatedAt = current.record.acceptedAt;
  assert.throws(() => prepare(current), reason("invalid_response"));
  assert.throws(
    () =>
      repositoryComparisonFromDeployments(
        scope,
        {
          ...query,
          window: {
            from: "2026-10-01T00:00:00.000Z",
            to: "2026-10-01T00:30:00.000Z",
          },
        },
        connection,
        head(),
        base(),
        asOf,
      ),
    reason("invalid_response"),
  );
});
test("disabled connections and another selected source cannot authorize a comparison", () => {
  assert.throws(
    () =>
      repositoryComparisonFromDeployments(
        scope,
        query,
        { ...connection, enabled: false },
        head(),
        base(),
        asOf,
      ),
    reason("not_authorized"),
  );
  assert.throws(
    () =>
      repositoryComparisonFromDeployments(
        scope,
        { ...query, sourceId: "other" },
        connection,
        head(),
        base(),
        asOf,
      ),
    reason("not_authorized"),
  );
});
