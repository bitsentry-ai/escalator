import test from "node:test";
import assert from "node:assert/strict";
import {
  detectionRuleVersionSchema,
  ruleCandidateInputSchema,
  ruleProposalClaimSchema,
  modelProfileSchema,
} from "@bitsentry-escalator/features/contracts";
import type { BoundedModelHttp } from "@bitsentry-escalator/features/investigation";
import { standaloneRuleProposalExecution } from "../../src/features/escalator/rules/execution.js";
import { SecretKeyRing } from "../../src/platform/secrets/keyring.js";
import type { PostgresRuleProposalModelAccess } from "../../src/platform/database/rule-proposal-model-access.js";
function fixture() {
  const parameters = {
    aggregation: "maximum",
    windowSeconds: 60,
    minimumSamples: 1,
    trigger: { operator: "gte", value: 1 },
    recovery: { operator: "lt", value: 1 },
    persistenceSeconds: 0,
    recoverySeconds: 0,
    cooldownSeconds: 0,
  };
  const version = detectionRuleVersionSchema.parse({
    id: "seed",
    revision: 1,
    definition: {
      languageVersion: 1,
      workspaceId: "org",
      serviceId: "api",
      environmentId: "prod",
      selector: { kind: "probe", streamId: "probe", field: "failure" },
      stepSeconds: 60,
      severity: "high",
      ...parameters,
    },
  });
  const input = ruleCandidateInputSchema.parse({
    version: 1,
    sourceSnapshotId: "snapshot",
    sourceInputHash: "a".repeat(64),
    seedVersion: version,
    profileId: "model",
    candidateId: "candidate",
    context: {
      cutoffAt: "2026-10-07T01:00:00.000Z",
      coverageVerified: false,
      seed: {
        selector: { kind: "probe", field: "failure" },
        stepSeconds: 60,
        collectionDelaySeconds: 0,
        parameters,
      },
      days: [
        {
          date: "2026-10-07",
          samples: 1,
          usable: 1,
          failures: 1,
          durationSum: 5,
          durationCount: 1,
          requests: 0,
          errors: 0,
          missingValues: 0,
        },
      ],
      reviewedLabels: [],
    },
  });
  const claim = ruleProposalClaimSchema.parse({
    workspaceId: "org",
    proposalId: "proposal",
    runtimeId: "runtime",
    token: "claim-token",
    attempt: 1,
    leaseExpiresAt: "2026-10-07T01:02:00.000Z",
  });
  const d = version.definition;
  const profile = modelProfileSchema.parse({
    id: "model",
    revision: 1,
    scope: {
      workspaceId: d.workspaceId,
      serviceId: d.serviceId,
      environmentId: d.environmentId,
    },
    destination: {
      provider: "ollama",
      model: "local",
      location: "local",
      origin: "http://127.0.0.1:11434",
    },
    endpoint: "http://127.0.0.1:11434",
    secretId: null,
  });
  const reads = { profile: 0, secret: 0, requests: 0, authorization: "" };
  const access: Pick<
    PostgresRuleProposalModelAccess,
    "readProfile" | "readSecret"
  > = {
    readProfile: async () => {
      reads.profile++;
      return profile;
    },
    readSecret: async () => {
      reads.secret++;
      throw new Error("Unexpected credential read");
    },
  };
  const transport: Pick<BoundedModelHttp, "bind"> = {
    bind: (endpoint, location) => {
      assert.equal(endpoint, profile.endpoint);
      assert.equal(location, "local");
      return async (_request, init) => {
        reads.requests++;
        reads.authorization =
          new Headers(init?.headers).get("authorization") ?? "";
        return Response.json({
          done: true,
          done_reason: "stop",
          eval_count: 12,
          response: JSON.stringify({
            parameters,
            rationale: "Additional detection",
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
    input,
    claim,
    profile,
    reads,
    access,
    transport,
    keys,
    execute: () =>
      standaloneRuleProposalExecution(access, keys, transport)(
        claim,
        input,
        new AbortController().signal,
      ),
  };
}
test("local proposal generation uses the approved profile without a provider key", async () => {
  const f = fixture(),
    result = await f.execute();
  assert.equal(result.candidate.id, "candidate");
  assert.equal(result.reviewable, false);
  assert.ok(f.reads.profile >= 2);
  assert.equal(f.reads.secret, 0);
  assert.equal(f.reads.requests, 1);
  assert.equal(f.reads.authorization, "");
});
test("revoked or changed profile prevents provider I/O", async () => {
  const f = fixture();
  f.access.readProfile = async () => undefined;
  await assert.rejects(f.execute());
  assert.equal(f.reads.requests, 0);
  f.access.readProfile = async () =>
    ++f.reads.profile === 1 ? f.profile : { ...f.profile, revision: 2 };
  await assert.rejects(f.execute());
  assert.equal(f.reads.requests, 0);
});
test("only the approved live claim can decrypt a model credential", async () => {
  const f = fixture();
  f.profile.secretId = "model_key";
  const bytes = Buffer.from(JSON.stringify({ token: "ephemeral-test-key" }));
  const envelope = f.keys.seal(
    { workspaceId: f.claim.workspaceId, id: "model_key" },
    bytes,
  );
  bytes.fill(0);
  f.access.readSecret = async (claim, request) => {
    f.reads.secret++;
    assert.equal(request.claimToken, claim.token);
    assert.equal(request.workId, claim.proposalId);
    return {
      id: "model_key",
      workspaceId: claim.workspaceId,
      disabled: false,
      envelope,
      claim: {
        workspaceId: claim.workspaceId,
        workId: claim.proposalId,
        queue: "job",
        state: "running",
        token: claim.token,
        expiresAt: claim.leaseExpiresAt,
        databaseNow: "2026-10-07T01:01:00.000Z",
        approvedSecretIds: ["model_key"],
      },
    };
  };
  const result = await f.execute();
  assert.equal(f.reads.secret, 1);
  assert.equal(f.reads.authorization, "Bearer ephemeral-test-key");
  assert.doesNotMatch(JSON.stringify(result), /ephemeral-test-key/);
  const read = f.access.readSecret;
  f.access.readSecret = async (...args) => {
    const row = await read(...args);
    return row
      ? { ...row, claim: { ...row.claim, token: "stale" } }
      : undefined;
  };
  await assert.rejects(f.execute());
  assert.equal(f.reads.requests, 1);
});
test("provider failure has no fallback and does not expose connection details", async () => {
  const f = fixture();
  f.transport.bind = () => async () => {
    f.reads.requests++;
    throw new Error("private connection detail");
  };
  await assert.rejects(f.execute(), (error) => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /private connection detail/);
    return true;
  });
  assert.equal(f.reads.requests, 1);
});
test("wrong tenant input cannot reach profile or credential access", async () => {
  const f = fixture();
  f.input.seedVersion.definition.workspaceId = ruleProposalClaimSchema.parse({
    ...f.claim,
    workspaceId: "other",
  }).workspaceId;
  await assert.rejects(async () => f.execute());
  assert.equal(f.reads.profile, 0);
  assert.equal(f.reads.secret, 0);
  assert.equal(f.reads.requests, 0);
});
