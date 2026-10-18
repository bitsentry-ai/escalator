import test from "node:test";
import assert from "node:assert/strict";
import { investigationFixture } from "@escalator-test/investigation-fixture";
import {
  modelProfileSchema,
  type BoundedModelHttp,
} from "@bitsentry-escalator/features/investigation";
import { SecretKeyRing } from "../../src/platform/secrets/keyring.js";
import {
  standaloneInvestigationExecution,
  type StandaloneInvestigationAccess,
} from "../../src/features/escalator/investigation/execution.js";
function fixture(fail = false) {
  const sample = investigationFixture();
  sample.claim.limits.maxDurationMs = 5000;
  const reads = { profile: 0, secret: 0, requests: [] as string[] };
  const { workspaceId, serviceId, environmentId } = sample.claim.scope;
  const repository: StandaloneInvestigationAccess = {
    trace: { append: async () => true },
    readProfile: async () => {
      reads.profile++;
      return modelProfileSchema.parse({
        id: sample.claim.profileId,
        revision: 1,
        scope: { workspaceId, serviceId, environmentId },
        destination: sample.result.report.destination,
        endpoint: "http://127.0.0.1:11434",
        secretId: null,
      });
    },
    readModelSecret: async () => {
      reads.secret++;
      throw new Error("Unexpected credential read");
    },
    readNativeEvidence: async () => ({
      status: "available",
      items: structuredClone(sample.result.evidence),
      truncated: false,
    }),
  };
  const transport: Pick<BoundedModelHttp, "bind"> = {
    bind: (endpoint, location) => {
      assert.equal(location, "local");
      reads.requests.push(endpoint);
      return async () => {
        if (fail) throw new Error("private connection detail");
        return Response.json({
          done: true,
          done_reason: "stop",
          eval_count: 12,
          response: JSON.stringify({
            summary: "HTTP errors observed",
            findings: [{ text: "HTTP 500", evidenceIds: ["evidence_a"] }],
          }),
        });
      };
    },
  };
  const keys = SecretKeyRing.parse({
    version: 1,
    activeKeyId: "test",
    keys: { test: Buffer.alloc(32, 7).toString("base64") },
  });
  return {
    ...sample,
    reads,
    repository,
    keys,
    transport,
    execute: standaloneInvestigationExecution(repository, keys, transport),
  };
}
test("standalone investigation composes evidence and a local model without a provider key", async () => {
  const f = fixture();
  const result = await f.execute(f.claim, new AbortController().signal);
  assert.equal(result.report.status, "complete");
  assert.equal(result.report.destination?.location, "local");
  assert.equal(result.report.findings[0].evidenceIds[0], "evidence_a");
  assert.ok(f.reads.profile >= 2);
  assert.equal(f.reads.secret, 0);
  assert.deepEqual(f.reads.requests, ["http://127.0.0.1:11434"]);
});
test("local model failure returns a partial report without remote fallback", async () => {
  const f = fixture(true);
  const result = await f.execute(f.claim, new AbortController().signal);
  assert.notEqual(result.report.status, "complete");
  assert.deepEqual(f.reads.requests, ["http://127.0.0.1:11434"]);
  assert.equal(f.reads.secret, 0);
  assert.doesNotMatch(
    JSON.stringify(result.report),
    /private connection detail/,
  );
});
test("revoked model profile prevents any standalone model request", async () => {
  const f = fixture();
  f.repository.readProfile = async () => undefined;
  const result = await f.execute(f.claim, new AbortController().signal);
  assert.notEqual(result.report.status, "complete");
  assert.deepEqual(f.reads.requests, []);
});

test("standalone model credentials are decrypted only for the approved active claim", async () => {
  const f = fixture();
  const original = f.repository.readProfile;
  f.repository.readProfile = async (claim) => {
    const profile = await original(claim);
    return profile ? { ...profile, secretId: "model_key" } : undefined;
  };
  const bytes = Buffer.from(JSON.stringify({ token: "ephemeral-test-key" }));
  const envelope = f.keys.seal(
    { id: "model_key", workspaceId: f.claim.scope.workspaceId },
    bytes,
  );
  bytes.fill(0);
  f.repository.readModelSecret = async (claim, id) => {
    f.reads.secret++;
    assert.equal(claim.claimToken, f.claim.claimToken);
    assert.equal(id, "model_key");
    return {
      id,
      workspaceId: claim.scope.workspaceId,
      envelope,
      disabled: false,
      claim: {
        workspaceId: claim.scope.workspaceId,
        workId: claim.id,
        queue: "job",
        state: "running",
        token: claim.claimToken,
        expiresAt: "2026-10-01T01:01:00.000Z",
        databaseNow: "2026-10-01T01:00:00.000Z",
        approvedSecretIds: [id],
      },
    };
  };
  const bind = f.transport.bind.bind(f.transport);
  f.transport.bind = (...args) => {
    const request = bind(...args);
    return async (input, init) => {
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer ephemeral-test-key",
      );
      return request(input, init);
    };
  };
  const result = await f.execute(f.claim, new AbortController().signal);
  assert.equal(result.report.status, "complete");
  assert.equal(f.reads.secret, 1);
  assert.doesNotMatch(JSON.stringify(result), /ephemeral-test-key/);
});
