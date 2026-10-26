import test from "node:test";
import assert from "node:assert/strict";
import {
  RepositoryEvidenceReader,
  type RepositoryEvidenceAccess,
} from "../src/investigation/evidence/repository-reader.js";
import { GithubDiffError } from "../src/investigation/evidence/github-http.js";
import { repositoryComparisonSchema } from "../src/investigation/evidence/github-diff.js";
import { evidenceQuerySchema } from "../src/contracts/index.js";
const comparison = () =>
  repositoryComparisonSchema.parse({
    scope: {
      workspaceId: "org_a",
      serviceId: "api",
      environmentId: "prod",
      incidentId: "incident",
    },
    sourceId: "github",
    owner: "bitsentry-ai",
    repository: "api",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    observedAt: "2026-10-01T01:00:00.000Z",
    deploymentReceivedAt: "2026-10-01T01:00:01.000Z",
  });
const query = evidenceQuerySchema.parse({
  kind: "git_diff",
  sourceId: "github",
  window: { from: "2026-10-01T00:30:00.000Z", to: "2026-10-01T01:00:00.000Z" },
  limit: 5,
});
const now = () => new Date("2026-10-01T01:05:00.000Z");
const body = () =>
  JSON.stringify({
    status: "ahead",
    ahead_by: 1,
    behind_by: 0,
    total_commits: 1,
    base_commit: { sha: "a".repeat(40) },
    merge_base_commit: { sha: "a".repeat(40) },
    commits: [{ sha: "b".repeat(40) }],
    files: [
      {
        filename: "index.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        changes: 2,
        patch: "-old\n+opaque test-secret",
      },
    ],
  });
const context = () => ({
  signal: new AbortController().signal,
  timeoutMs: 1000,
  maxBytes: 262144,
});
const access: RepositoryEvidenceAccess = {
  use: async (_scope, _query, _context, operation) =>
    operation(comparison(), "test-secret"),
};
const assertUnavailable = (
  value: Awaited<ReturnType<RepositoryEvidenceReader["read"]>>,
  reason: string,
) => {
  assert.equal(value.status, "unavailable");
  if (value.status === "unavailable")
    assert.equal(value.unavailable.reason, reason);
};
test("host-authorized callback returns scoped redacted evidence and excludes the credential", async () => {
  let calls = 0;
  const reader = new RepositoryEvidenceReader(
    access,
    {
      read: async (binding, token, ctx) => {
        calls++;
        assert.deepEqual(binding, comparison());
        assert.equal(token, "test-secret");
        assert.ok(ctx.timeoutMs > 0 && ctx.timeoutMs <= 1000);
        return body();
      },
    },
    now,
  );
  const result = await reader.read(comparison().scope, query, context());
  assert.equal(result.status, "available");
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(result), /test-secret/);
  if (result.status === "available") {
    assert.equal(result.items.length, 2);
    assert.equal(result.items[0]!.reference.receivedAt, now().toISOString());
  }
});
test("revocation after provider I/O discards evidence before it can be published", async () => {
  let calls = 0;
  const revoked: RepositoryEvidenceAccess = {
    use: async (_s, _q, _c, operation) => {
      await operation(comparison(), undefined);
      return undefined;
    },
  };
  const reader = new RepositoryEvidenceReader(
    revoked,
    {
      read: async () => {
        calls++;
        return body();
      },
    },
    now,
  );
  assertUnavailable(
    await reader.read(comparison().scope, query, context()),
    "not_authorized",
  );
  assert.equal(calls, 1);
});
test("missing live authorization performs no provider request", async () => {
  let calls = 0;
  const denied: RepositoryEvidenceAccess = { use: async () => undefined };
  const reader = new RepositoryEvidenceReader(
    denied,
    {
      read: async () => {
        calls++;
        return body();
      },
    },
    now,
  );
  assertUnavailable(
    await reader.read(comparison().scope, query, context()),
    "not_authorized",
  );
  assert.equal(calls, 0);
});
test("mismatched scope, source and time window are rejected before sending credentials", async () => {
  let calls = 0;
  const read = async () => {
    calls++;
    return body();
  };
  for (const changed of [
    { ...comparison(), sourceId: "other" },
    { ...comparison(), scope: { ...comparison().scope, incidentId: "other" } },
    { ...comparison(), observedAt: "2026-10-01T00:00:00.000Z" },
  ]) {
    const bound: RepositoryEvidenceAccess = {
      use: async (_s, _q, _c, operation) => operation(changed, "test-secret"),
    };
    const reader = new RepositoryEvidenceReader(bound, { read }, now);
    assertUnavailable(
      await reader.read(comparison().scope, query, context()),
      "not_authorized",
    );
  }
  assert.equal(calls, 0);
});
test("future deployment receipt cannot authorize a provider request", async () => {
  const bound: RepositoryEvidenceAccess = {
    use: async (_s, _q, _c, operation) =>
      operation(
        { ...comparison(), deploymentReceivedAt: "2026-10-02T00:00:00.000Z" },
        undefined,
      ),
  };
  let calls = 0;
  const reader = new RepositoryEvidenceReader(
    bound,
    {
      read: async () => {
        calls++;
        return body();
      },
    },
    now,
  );
  assertUnavailable(
    await reader.read(comparison().scope, query, context()),
    "invalid_response",
  );
  assert.equal(calls, 0);
});
test("one host access callback cannot trigger repeated provider reads", async () => {
  let calls = 0;
  const repeated: RepositoryEvidenceAccess = {
    use: async (_s, _q, _c, operation) => {
      await operation(comparison(), undefined);
      return operation(comparison(), undefined);
    },
  };
  const reader = new RepositoryEvidenceReader(
    repeated,
    {
      read: async () => {
        calls++;
        return body();
      },
    },
    now,
  );
  assertUnavailable(
    await reader.read(comparison().scope, query, context()),
    "not_authorized",
  );
  assert.equal(calls, 1);
});
test("another evidence kind does not fall back to repository access", async () => {
  let calls = 0;
  const bound: RepositoryEvidenceAccess = {
    use: async () => {
      calls++;
      return undefined;
    },
  };
  const reader = new RepositoryEvidenceReader(
    bound,
    { read: async () => body() },
    now,
  );
  assertUnavailable(
    await reader.read(comparison().scope, { ...query, kind: "log" }, context()),
    "not_configured",
  );
  assert.equal(calls, 0);
});
test("fixed transport errors become fixed unavailable reasons without leaking raw errors", async () => {
  for (const failure of [
    "not_found",
    "not_authorized",
    "invalid_response",
    "unreachable",
    "timeout",
    "invalid_configuration",
  ] as const) {
    const reader = new RepositoryEvidenceReader(
      access,
      {
        read: async () => {
          throw new GithubDiffError(failure);
        },
      },
      now,
    );
    assertUnavailable(
      await reader.read(comparison().scope, query, context()),
      failure === "invalid_configuration" ? "not_configured" : failure,
    );
  }
  const broken = new RepositoryEvidenceReader(
    {
      use: async () => {
        throw new Error("test-secret");
      },
    },
    { read: async () => body() },
    now,
  );
  const result = await broken.read(comparison().scope, query, context());
  assertUnavailable(result, "unreachable");
  assert.doesNotMatch(JSON.stringify(result), /test-secret/);
});
test("provider timeout and caller cancellation bound a host access operation", async () => {
  const hanging: RepositoryEvidenceAccess = {
    use: () => new Promise(() => {}),
  };
  const reader = new RepositoryEvidenceReader(
    hanging,
    { read: async () => body() },
    now,
  );
  assertUnavailable(
    await reader.read(comparison().scope, query, {
      ...context(),
      timeoutMs: 5,
    }),
    "timeout",
  );
  const controller = new AbortController();
  const pending = reader.read(comparison().scope, query, {
    ...context(),
    signal: controller.signal,
  });
  controller.abort();
  assertUnavailable(await pending, "cancelled");
});
test("late authorization after cancellation cannot start a provider call", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const delayed: RepositoryEvidenceAccess = {
    use: async (_s, _q, _c, operation) => {
      await gate;
      return operation(comparison(), undefined);
    },
  };
  const reader = new RepositoryEvidenceReader(
    delayed,
    {
      read: async () => {
        calls++;
        return body();
      },
    },
    now,
  );
  const controller = new AbortController();
  const pending = reader.read(comparison().scope, query, {
    ...context(),
    signal: controller.signal,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  assertUnavailable(await pending, "cancelled");
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
});
