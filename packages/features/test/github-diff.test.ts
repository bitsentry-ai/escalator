import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeGithubDiff,
  repositoryComparisonSchema,
} from "../src/investigation/evidence/github-diff.js";
import {
  evidenceQuerySchema,
  investigationScopeSchema,
} from "../src/contracts/index.js";
const baseSha = "a".repeat(40),
  headSha = "b".repeat(40);
const at = "2026-10-01T01:00:00.000Z",
  received = "2026-10-01T01:00:01.000Z",
  collected = "2026-10-01T01:05:00.000Z";
const scope = investigationScopeSchema.parse({
  workspaceId: "org_a",
  serviceId: "api",
  environmentId: "prod",
  incidentId: "incident",
});
const query = evidenceQuerySchema.parse({
  kind: "git_diff",
  sourceId: "repository",
  window: { from: "2026-10-01T00:00:00.000Z", to: at },
  limit: 5,
});
const binding = () =>
  repositoryComparisonSchema.parse({
    scope,
    sourceId: "repository",
    owner: "bitsentry-ai",
    repository: "api",
    baseSha,
    headSha,
    observedAt: at,
    deploymentReceivedAt: received,
  });
const file = (filename = "index.ts") => ({
  filename,
  status: "modified",
  additions: 1,
  deletions: 1,
  changes: 2,
  patch: "-return 1;\n+return 2;",
  raw_url: "https://evil.example/never-read",
});
const response = () => ({
  status: "ahead",
  ahead_by: 1,
  behind_by: 0,
  total_commits: 1,
  base_commit: { sha: baseSha },
  merge_base_commit: { sha: baseSha },
  commits: [{ sha: headSha }],
  files: [file()],
  html_url: "https://evil.example/ignored",
  author: { email: "unneeded@example.com" },
});
const read = (value: unknown = response(), maxBytes = 262144) =>
  normalizeGithubDiff(
    scope,
    query,
    binding(),
    JSON.stringify(value),
    collected,
    maxBytes,
  );
const unavailable = (
  result: ReturnType<typeof read>,
  reason = "invalid_response",
) => {
  assert.equal(result.status, "unavailable");
  if (result.status === "unavailable")
    assert.equal(result.unavailable.reason, reason);
};
test("approved immutable diff keeps provenance and projects only file facts", () => {
  const result = read();
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.items.length, 2);
  assert.equal(result.truncated, false);
  for (const item of result.items) {
    assert.deepEqual(item.scope, scope);
    assert.deepEqual(item.window, query.window);
    assert.equal(item.reference.kind, "git_diff");
    assert.equal(item.reference.receivedAt, collected);
    assert.equal(item.collectedAt, collected);
  }
  assert.match(result.items[1]!.text, /return 2/);
  assert.doesNotMatch(JSON.stringify(result), /evil\.example|unneeded/);
  assert.deepEqual(result, read());
});
test("known credentials and secret assignments are redacted before evidence clipping", () => {
  const value = response();
  value.files[0]!.patch =
    "+password=never-retain\n+url https://example.com/?secret=hidden\n+opaque tracked-secret";
  const result = normalizeGithubDiff(
    scope,
    query,
    binding(),
    JSON.stringify(value),
    collected,
    262144,
    ["tracked-secret"],
  );
  assert.equal(result.status, "available");
  assert.doesNotMatch(
    JSON.stringify(result),
    /never-retain|tracked-secret|hidden/,
  );
});
test("missing binary or oversized patches remain explicit incomplete evidence", () => {
  const value = response();
  delete (value.files[0] as Partial<ReturnType<typeof file>>).patch;
  const result = read(value);
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.truncated, true);
  assert.equal(result.items[1]!.truncated, true);
  assert.match(result.items[1]!.text, /patchUnavailable.*true/);
});
test("the 300-file provider ceiling is never represented as complete coverage", () => {
  const value = response();
  value.files = Array.from({ length: 300 }, (_, i) => file(`file-${i}`));
  const result = read(value);
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.items.length, query.limit);
  assert.equal(result.truncated, true);
  assert.match(result.items[0]!.text, /fileListMayBeCapped.*true/);
});
test("query file budget preserves the summary and marks omitted file evidence", () => {
  const result = normalizeGithubDiff(
    scope,
    { ...query, limit: 1 },
    binding(),
    JSON.stringify(response()),
    collected,
    262144,
  );
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.items.length, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.items[0]!.truncated, true);
});
test("byte budget bounds the serialized result and cannot manufacture empty success", () => {
  unavailable(read(response(), 1), "budget_exhausted");
  const full = read();
  assert.equal(full.status, "available");
  if (full.status !== "available") return;
  const limit = Buffer.byteLength(JSON.stringify([full.items[0]]));
  const bounded = read(response(), limit);
  assert.equal(bounded.status, "available");
  if (bounded.status !== "available") return;
  assert.equal(bounded.items.length, 1);
  assert.equal(bounded.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded.items)) <= limit);
});
for (const key of [
  "workspaceId",
  "serviceId",
  "environmentId",
  "incidentId",
] as const)
  test(`rejects comparison scope mismatch: ${key}`, () => {
    const other = binding();
    other.scope = investigationScopeSchema.parse({ ...scope, [key]: "other" });
    unavailable(
      normalizeGithubDiff(
        scope,
        query,
        other,
        JSON.stringify(response()),
        collected,
        262144,
      ),
      "not_authorized",
    );
  });
test("rejects unrelated source or evidence kind", () => {
  unavailable(
    normalizeGithubDiff(
      scope,
      { ...query, sourceId: "other" },
      binding(),
      JSON.stringify(response()),
      collected,
      262144,
    ),
    "not_authorized",
  );
  unavailable(
    normalizeGithubDiff(
      scope,
      { ...query, kind: "deployment" },
      binding(),
      JSON.stringify(response()),
      collected,
      262144,
    ),
    "not_authorized",
  );
});
for (const kind of ["behind", "diverged"])
  test(`does not treat ${kind} comparison as an exact deployment diff`, () => {
    const value = response();
    value.status = kind;
    unavailable(read(value));
  });
test("rejects mismatched base, merge base, and final commit", () => {
  for (const change of [
    (v: ReturnType<typeof response>) => (v.base_commit.sha = headSha),
    (v: ReturnType<typeof response>) => (v.merge_base_commit.sha = headSha),
    (v: ReturnType<typeof response>) => (v.commits[0]!.sha = baseSha),
  ]) {
    const value = response();
    change(value);
    unavailable(read(value));
  }
});
test("rejects truncated, duplicate, or inconsistent commit lists", () => {
  const missing = response();
  missing.total_commits = 2;
  missing.ahead_by = 2;
  unavailable(read(missing));
  const duplicate = response();
  duplicate.commits.push({ sha: headSha });
  duplicate.total_commits = 2;
  duplicate.ahead_by = 2;
  unavailable(read(duplicate));
  const tooMany = response();
  tooMany.total_commits = 251;
  unavailable(read(tooMany));
  const behind = response();
  behind.behind_by = 1;
  unavailable(read(behind));
});
test("identical immutable commits have positive evidence of no file changes", () => {
  const value = response();
  value.status = "identical";
  value.total_commits = 0;
  value.ahead_by = 0;
  value.commits = [];
  value.files = [];
  const result = normalizeGithubDiff(
    scope,
    query,
    { ...binding(), headSha: baseSha },
    JSON.stringify(value),
    collected,
    262144,
  );
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.items.length, 1);
  assert.equal(result.truncated, false);
  assert.match(result.items[0]!.text, /identical/);
  value.files = [file()];
  unavailable(
    normalizeGithubDiff(
      scope,
      query,
      { ...binding(), headSha: baseSha },
      JSON.stringify(value),
      collected,
      262144,
    ),
  );
});
test("rejects duplicate files and invalid statuses rather than trusting provider shape", () => {
  const duplicate = response();
  duplicate.files.push(file());
  unavailable(read(duplicate));
  const invalid = response();
  invalid.files[0]!.status = "execute";
  unavailable(read(invalid));
  unavailable(read({}));
  unavailable(
    normalizeGithubDiff(scope, query, binding(), "{", collected, 262144),
  );
});
test("rejects future receipts, collection before event, and events outside the query window", () => {
  for (const change of [
    { deploymentReceivedAt: "2026-10-02T00:00:00.000Z" },
    { observedAt: "2026-10-02T00:00:00.000Z" },
    { observedAt: "2026-09-30T00:00:00.000Z" },
  ])
    unavailable(
      normalizeGithubDiff(
        scope,
        query,
        { ...binding(), ...change },
        JSON.stringify(response()),
        collected,
        262144,
      ),
    );
  unavailable(
    normalizeGithubDiff(
      scope,
      query,
      binding(),
      JSON.stringify(response()),
      "2026-10-01T00:00:00.000Z",
      262144,
    ),
  );
});
test("oversized bodies fail before parsing and invalid budgets throw", () => {
  unavailable(
    normalizeGithubDiff(
      scope,
      query,
      binding(),
      "x".repeat(1048577),
      collected,
      262144,
    ),
  );
  for (const budget of [0, -1, 1.5, 262145, NaN])
    assert.throws(() => read(response(), budget), RangeError);
});
test("long patch output is redacted first, clipped within evidence limits and marked incomplete", () => {
  const value = response();
  value.files[0]!.patch = "+" + "a".repeat(20000) + "\n+token=never-retain";
  const result = read(value);
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.truncated, true);
  assert.ok(result.items[1]!.text.length <= 16384);
  assert.doesNotMatch(JSON.stringify(result), /never-retain/);
});
test("connection names and commit selectors cannot contain path traversal or symbolic refs", () => {
  for (const change of [
    { owner: "../owner" },
    { repository: "a/b" },
    { baseSha: "main" },
    { headSha: "HEAD" },
  ])
    assert.equal(
      repositoryComparisonSchema.safeParse({ ...binding(), ...change }).success,
      false,
    );
});

test("a present patch that omits declared changes is still incomplete", () => {
  const value = response();
  value.files[0]!.additions = 5;
  value.files[0]!.changes = 6;
  const result = read(value);
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.truncated, true);
  assert.equal(result.items[1]!.truncated, true);
  assert.match(result.items[1]!.text, /patchIncomplete.*true/);
});

test("dot-prefixed repository names are supported without permitting dot path segments", () => {
  assert.equal(
    repositoryComparisonSchema.safeParse({
      ...binding(),
      repository: ".github",
    }).success,
    true,
  );
  for (const repository of [".", "..", "%2e%2e", "name?query=secret"])
    assert.equal(
      repositoryComparisonSchema.safeParse({ ...binding(), repository })
        .success,
      false,
    );
});
