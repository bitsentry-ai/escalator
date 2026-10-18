import test from "node:test";
import assert from "node:assert/strict";
import { investigationFixture } from "@escalator-test/investigation-fixture";
import {
  evidenceQuerySchema,
  investigationScopeSchema,
} from "@bitsentry-escalator/features/contracts";
import { repositoryComparisonSchema } from "@bitsentry-escalator/features/investigation";
import { SecretKeyRing } from "../../src/platform/secrets/keyring.js";
import {
  standaloneRepositoryEvidenceAccess,
  type StandaloneRepositoryAccess,
} from "../../src/features/escalator/investigation/repository-access.js";
function fixture(privateRepository = false) {
  const original = investigationFixture().claim;
  const query = evidenceQuerySchema.parse({
    kind: "git_diff",
    sourceId: "github",
    limit: 5,
    window: {
      from: "2026-10-01T00:30:00.000Z",
      to: "2026-10-01T01:00:00.000Z",
    },
  });
  const claim = { ...original, sources: [query] };
  const keys = SecretKeyRing.parse({
    version: 1,
    activeKeyId: "test",
    keys: { test: Buffer.alloc(32, 7).toString("base64") },
  });
  const comparison = repositoryComparisonSchema.parse({
    scope: claim.scope,
    sourceId: query.sourceId,
    owner: "bitsentry-ai",
    repository: "api",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    observedAt: query.window.to,
    deploymentReceivedAt: "2026-10-01T01:00:01.000Z",
  });
  const identity = {
    id: "repository_key",
    workspaceId: claim.scope.workspaceId,
  };
  let snapshot: Awaited<
    ReturnType<StandaloneRepositoryAccess["readRepositoryEvidence"]>
  > = {
    comparison,
    secret: privateRepository
      ? {
          ...identity,
          disabled: false,
          envelope: keys.seal(
            identity,
            Buffer.from(JSON.stringify({ token: "test-repository-key" })),
          ),
          claim: {
            workspaceId: claim.scope.workspaceId,
            workId: claim.id,
            queue: "job",
            state: "running",
            token: claim.claimToken,
            expiresAt: "2026-10-01T01:06:00.000Z",
            databaseNow: "2026-10-01T01:05:00.000Z",
            approvedSecretIds: [identity.id],
          },
        }
      : null,
  };
  let reads = 0;
  const repository: StandaloneRepositoryAccess = {
    readRepositoryEvidence: async (requestedClaim, requestedQuery) => {
      assert.deepEqual(requestedClaim, claim);
      assert.deepEqual(requestedQuery, query);
      reads++;
      return structuredClone(snapshot);
    },
  };
  const controller = new AbortController();
  const context = { signal: controller.signal, timeoutMs: 1000 };
  return {
    claim,
    query,
    keys,
    comparison,
    controller,
    context,
    access: standaloneRepositoryEvidenceAccess(repository, claim, keys),
    reads: () => reads,
    snapshot: () => snapshot!,
    revoke: () => {
      snapshot = undefined;
    },
  };
}
test("public repository access rechecks the durable claim after provider I/O", async () => {
  const f = fixture();
  const value = await f.access.use(
    f.claim.scope,
    f.query,
    f.context,
    async (comparison, token) => {
      assert.equal(f.reads(), 1);
      assert.deepEqual(comparison, f.comparison);
      assert.equal(token, undefined);
      return "normalized evidence";
    },
  );
  assert.equal(value, "normalized evidence");
  assert.equal(f.reads(), 2);
});
test("private repository decrypts only the captured credential for the callback", async () => {
  const f = fixture(true);
  const result = await f.access.use(
    f.claim.scope,
    f.query,
    f.context,
    async (_comparison, token) => {
      assert.equal(token, "test-repository-key");
      return { evidence: "redacted" };
    },
  );
  assert.deepEqual(result, { evidence: "redacted" });
  assert.equal(f.reads(), 2);
});
test("scope mismatch never queries the repository or calls the provider", async () => {
  const f = fixture();
  assert.equal(
    await f.access.use(
      investigationScopeSchema.parse({ ...f.claim.scope, incidentId: "other" }),
      f.query,
      f.context,
      async () => assert.fail(),
    ),
    undefined,
  );
  assert.equal(f.reads(), 0);
});
test("missing initial authorization never calls the provider", async () => {
  const f = fixture();
  f.revoke();
  assert.equal(
    await f.access.use(f.claim.scope, f.query, f.context, async () =>
      assert.fail(),
    ),
    undefined,
  );
  assert.equal(f.reads(), 1);
});
test("revocation during provider I/O discards the result", async () => {
  const f = fixture(true);
  assert.equal(
    await f.access.use(f.claim.scope, f.query, f.context, async () => {
      f.revoke();
      return "discard";
    }),
    undefined,
  );
});
test("a changed deployment comparison discards provider evidence", async () => {
  const f = fixture();
  assert.equal(
    await f.access.use(f.claim.scope, f.query, f.context, async () => {
      f.snapshot().comparison.headSha = "c".repeat(40);
      return "discard";
    }),
    undefined,
  );
});
test("credential rotation during provider I/O discards the old result", async () => {
  const f = fixture(true);
  assert.equal(
    await f.access.use(f.claim.scope, f.query, f.context, async () => {
      f.snapshot().secret!.envelope = f.keys.seal(
        f.snapshot().secret!,
        Buffer.from(JSON.stringify({ token: "replacement" })),
      );
      return "discard";
    }),
    undefined,
  );
});
for (const defect of [
  "expired",
  "wrong_token",
  "wrong_id",
  "disabled",
] as const) {
  test(`private repository refuses ${defect} persisted authorization`, async () => {
    const f = fixture(true),
      record = f.snapshot().secret!;
    if (defect === "expired") record.claim.expiresAt = record.claim.databaseNow;
    if (defect === "wrong_token") record.claim.token = "other";
    if (defect === "wrong_id") record.claim.approvedSecretIds = ["model_key"];
    if (defect === "disabled") record.disabled = true;
    await assert.rejects(
      f.access.use(f.claim.scope, f.query, f.context, async () =>
        assert.fail(),
      ),
      /Secret is unavailable/,
    );
  });
}
test("malformed credential bundles fail without exposing plaintext", async () => {
  const f = fixture(true),
    record = f.snapshot().secret!;
  record.envelope = f.keys.seal(
    record,
    Buffer.from('{"token":"private value with spaces"}'),
  );
  await assert.rejects(
    f.access.use(f.claim.scope, f.query, f.context, async () => assert.fail()),
    (error) =>
      error instanceof Error &&
      error.message === "Secret is unavailable for this operation",
  );
});
test("cancellation before authorization performs no read", async () => {
  const f = fixture();
  f.controller.abort();
  await assert.rejects(
    f.access.use(f.claim.scope, f.query, f.context, async () => assert.fail()),
  );
  assert.equal(f.reads(), 0);
});
test("cancellation during provider I/O prevents result release", async () => {
  const f = fixture();
  await assert.rejects(
    f.access.use(f.claim.scope, f.query, f.context, async () => {
      f.controller.abort();
      return "discard";
    }),
  );
  assert.equal(f.reads(), 1);
});
