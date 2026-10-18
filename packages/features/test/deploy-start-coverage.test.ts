import test from "node:test";
import assert from "node:assert/strict";
import { DeploymentPreflight } from "../src/application/deploy/preflight.js";
import { DeploymentManagement } from "../src/application/deploy/management.js";
import { MemoryCoverageRepository } from "./conformance/memory-coverage.js";
import { seedCoverageFixture } from "./conformance/coverage.js";
import {
  workspaceIdSchema,
  responderIdSchema,
  type Actor,
  type DeploymentToken,
} from "../src/contracts/index.js";
import type { CoverageRepository } from "../src/application/deploy/coverage-ports.js";
const input = {
  version: 1 as const,
  source: "ci",
  externalId: "run-1",
  environmentId: "prod",
};
async function fixture() {
  let at = Date.parse("2026-10-04T12:00:00.000Z"),
    sequence = 0,
    enabled = true;
  const repository = new MemoryCoverageRepository({ now: () => new Date(at) });
  const actor: Actor = {
    workspaceId: workspaceIdSchema.parse("preflight-workspace"),
    responderId: responderIdSchema.parse("operator"),
    role: "administrator",
  };
  await seedCoverageFixture(
    {
      repository,
      configuration: repository.configuration,
      work: repository.work,
      providerSecret: async () => "fixture-secret",
      dispose: async () => {},
    },
    actor.workspaceId,
  );
  const ids = () => `preflight-${++sequence}`;
  const management = new DeploymentManagement(repository, ids);
  const service = new DeploymentPreflight(
    repository,
    ids,
    (scope) => enabled && scope === actor.workspaceId,
  );
  const issue = (
    capabilities: DeploymentToken["capabilities"] = ["deployment:write"],
    mappedDeployerId: DeploymentToken["mappedDeployerId"] = responderIdSchema.parse(
      "primary",
    ),
  ) =>
    management.issueToken(actor, {
      targetId: "target",
      capabilities,
      mappedDeployerId,
      ttlSeconds: 3600,
    });
  return {
    repository,
    actor,
    ids,
    management,
    service,
    issue,
    advance: (ms: number) => {
      at += ms;
    },
    disable: () => {
      enabled = false;
    },
    audit: () =>
      repository.transaction(actor.workspaceId, (tx) =>
        tx.audit.list({ limit: 100 }),
      ),
  };
}

import {
  DeploymentCommands,
  DeploymentCoverageUnavailableError,
} from "../src/application/deploy/commands.js";
import { DeploymentAccess } from "../src/application/deploy/access.js";
import type { CoverageTransaction } from "../src/application/deploy/coverage-ports.js";
import { DeploymentHttp } from "../src/application/deploy/http.js";
const start = {
  ...input,
  actor: "CI display name",
  commit: "abc123",
  artifact: null,
  occurredAt: "2026-10-04T12:00:00.000Z",
};
function commands(
  f: Awaited<ReturnType<typeof fixture>>,
  repo: CoverageRepository = f.repository,
) {
  const preflight = new DeploymentPreflight(repo, f.ids, () => true);
  return new DeploymentCommands(
    new DeploymentAccess<CoverageTransaction>(
      repo,
      (scope) => scope === f.actor.workspaceId,
    ),
    f.ids,
    (context, input) => preflight.requireForStart(context, input),
  );
}
async function stored(f: Awaited<ReturnType<typeof fixture>>) {
  return f.repository.transaction(f.actor.workspaceId, (tx) =>
    tx.deployments.list("target", { limit: 100 }),
  );
}
test("guarded starts persist their applied proof and receipts replay without issuing a new authorization", async () => {
  const f = await fixture(),
    grant = await f.issue(["deployment:write", "deployment:read"]),
    cmd = commands(f);
  const proof = await f.service.preflight(grant.token, "preflight", input),
    body = { ...start, coverageDecisionId: proof.proof.id };
  const accepted = await cmd.start(grant.token, "start", body);
  if (accepted.state === "rejected") throw new Error("expected acceptance");
  assert.equal(accepted.state, "accepted");
  assert.equal(accepted.coverageDecisionId, proof.proof.id);
  assert.equal(
    (await cmd.get(grant.token, accepted.deploymentId)).coverageDecisionId,
    proof.proof.id,
  );
  f.advance(120000);
  const finished = await cmd.finish(
    grant.token,
    accepted.deploymentId,
    "finish",
    {
      ...input,
      actor: "CI display name",
      outcome: "SUCCEEDED",
      occurredAt: "2026-10-04T12:02:00.000Z",
    },
  );
  if (finished.state === "rejected") throw new Error("expected finish");
  assert.equal(finished.state, "accepted");
  assert.equal(finished.coverageDecisionId, proof.proof.id);
  assert.equal(
    (await cmd.get(grant.token, accepted.deploymentId)).coverageDecisionId,
    proof.proof.id,
  );
  assert.deepEqual(await cmd.start(grant.token, "start", body), accepted);
  const duplicate = await cmd.start(grant.token, "duplicate", body);
  assert.equal(duplicate.state, "duplicate");
  assert.equal((await stored(f)).items.length, 1);
  await f.management.revokeToken(f.actor, { targetId: "target", id: grant.id });
  await assert.rejects(cmd.start(grant.token, "start", body), {
    code: "invalid_token",
  });
});
test("expired decisions cannot create a deployment or consume its command key", async () => {
  const f = await fixture(),
    grant = await f.issue(),
    cmd = commands(f),
    proof = await f.service.preflight(grant.token, "preflight", input);
  f.advance(120000);
  await assert.rejects(
    cmd.start(grant.token, "start", {
      ...start,
      coverageDecisionId: proof.proof.id,
    }),
    { reason: "expired" },
  );
  assert.equal((await stored(f)).items.length, 0);
  assert.equal(
    await f.repository.transaction(f.actor.workspaceId, (tx) =>
      tx.receipts.get("target", "start"),
    ),
    undefined,
  );
  const fresh = await f.service.preflight(grant.token, "new-preflight", input);
  assert.equal(
    (
      await cmd.start(grant.token, "start", {
        ...start,
        coverageDecisionId: fresh.proof.id,
      })
    ).state,
    "accepted",
  );
});
test("missing, mismatched deployment and mismatched mapped-deployer proofs fail closed", async () => {
  const f = await fixture(),
    grant = await f.issue(),
    cmd = commands(f),
    proof = await f.service.preflight(grant.token, "preflight", input);
  await assert.rejects(
    cmd.start(grant.token, "missing", {
      ...start,
      coverageDecisionId: "absent",
    }),
    { reason: "missing" },
  );
  for (const patch of [{ source: "other" }, { externalId: "other" }])
    await assert.rejects(
      cmd.start(grant.token, "mismatch", {
        ...start,
        ...patch,
        coverageDecisionId: proof.proof.id,
      }),
      { reason: "stale" },
    );
  const peer = await f.issue(
    ["deployment:write"],
    responderIdSchema.parse("peer"),
  );
  await assert.rejects(
    cmd.start(peer.token, "peer", {
      ...start,
      coverageDecisionId: proof.proof.id,
    }),
    { reason: "stale" },
  );
  assert.equal((await stored(f)).items.length, 0);
});
test("changed contact configuration rejects a proof that has not expired", async () => {
  const f = await fixture(),
    grant = await f.issue(),
    cmd = commands(f),
    proof = await f.service.preflight(grant.token, "preflight", input);
  await f.repository.configuration.transaction(
    f.actor.workspaceId,
    async (tx) => {
      const contact = (await tx.configuration.contacts.get("contact-peer"))!;
      await tx.configuration.contacts.put(
        { ...contact, enabled: false, version: contact.version + 1 },
        contact.version,
      );
    },
  );
  await assert.rejects(
    cmd.start(grant.token, "start", {
      ...start,
      coverageDecisionId: proof.proof.id,
    }),
    { reason: "stale" },
  );
  assert.equal((await stored(f)).items.length, 0);
});
test("an unconfigured guard cannot claim approval; tracking-only starts carry no proof", async () => {
  const f = await fixture(),
    grant = await f.issue(),
    plain = new DeploymentCommands(
      new DeploymentAccess(f.repository, () => true),
      f.ids,
    ),
    proof = await f.service.preflight(grant.token, "preflight", input);
  await assert.rejects(
    plain.start(grant.token, "start", {
      ...start,
      coverageDecisionId: proof.proof.id,
    }),
    DeploymentCoverageUnavailableError,
  );
  const accepted = await plain.start(grant.token, "tracking", start);
  assert.equal(accepted.state, "accepted");
  assert.equal("coverageDecisionId" in accepted, false);
  const retrofit = await commands(f).start(grant.token, "retrofit", {
    ...start,
    coverageDecisionId: proof.proof.id,
  });
  assert.equal(retrofit.state, "rejected");
  assert.equal(
    (await stored(f)).items[0]!.deployment.coverageDecisionId,
    undefined,
  );
});
test("a revoked override cannot authorize a new start", async () => {
  const f = await fixture(),
    grant = await f.issue(["deployment:write"], null),
    proof = await f.service.preflight(grant.token, "preflight", input);
  const overridden = await f.service.override(f.actor, {
    targetId: "target",
    decisionId: proof.proof.id,
    key: "override",
    reason: "Operator will cover",
  });
  const revoked: CoverageRepository = {
    findTokenContext: (hash) => f.repository.findTokenContext(hash),
    transaction: (scope, run) =>
      f.repository.transaction(scope, (tx) =>
        run({
          ...tx,
          responders: {
            ...tx.responders,
            get: async (id) => {
              const row = await tx.responders.get(id);
              return row?.id === f.actor.responderId
                ? { ...row, enabled: false }
                : row;
            },
          },
        }),
      ),
  };
  await assert.rejects(
    commands(f, revoked).start(grant.token, "start", {
      ...start,
      coverageDecisionId: overridden.proof.id,
    }),
    { reason: "override_revoked" },
  );
  assert.equal((await stored(f)).items.length, 0);
});
test("failed audit rolls back a validated start, receipt and proof link together", async () => {
  const f = await fixture(),
    grant = await f.issue(),
    proof = await f.service.preflight(grant.token, "preflight", input);
  const failed: CoverageRepository = {
    findTokenContext: (hash) => f.repository.findTokenContext(hash),
    transaction: (scope, run) =>
      f.repository.transaction(scope, (tx) =>
        run({
          ...tx,
          audit: {
            ...tx.audit,
            append: async () => {
              throw new Error("audit unavailable");
            },
          },
        }),
      ),
  };
  await assert.rejects(
    commands(f, failed).start(grant.token, "start", {
      ...start,
      coverageDecisionId: proof.proof.id,
    }),
    /audit unavailable/,
  );
  assert.equal((await stored(f)).items.length, 0);
  assert.equal(
    await f.repository.transaction(f.actor.workspaceId, (tx) =>
      tx.receipts.get("target", "start"),
    ),
    undefined,
  );
});
test("machine responses distinguish blocked coverage from unavailable infrastructure without exposing proof details", async () => {
  const f = await fixture(),
    grant = await f.issue(),
    proof = await f.service.preflight(grant.token, "preflight", input);
  f.advance(120000);
  const request = {
    authorization: `Bearer ${grant.token}`,
    contentType: "application/json",
    idempotencyKey: "start",
    body: new TextEncoder().encode(
      JSON.stringify({ ...start, coverageDecisionId: proof.proof.id }),
    ),
  };
  assert.deepEqual(await new DeploymentHttp(commands(f)).start(request), {
    status: 409,
    body: { error: "coverage_blocked" },
  });
  const plain = new DeploymentCommands(
    new DeploymentAccess(f.repository, () => true),
    f.ids,
  );
  assert.deepEqual(await new DeploymentHttp(plain).start(request), {
    status: 503,
    body: { error: "unavailable" },
  });
});
test("storage rejects forged proof references and mismatched receipt links", async () => {
  const f = await fixture(),
    grant = await f.issue(),
    proof = await f.service.preflight(grant.token, "preflight", input);
  const { startDeployment } = await import("../src/domain/deploy/lifecycle.js");
  await assert.rejects(
    f.repository.transaction(f.actor.workspaceId, async (tx) => {
      const target = (await tx.targets.get("target"))!;
      const decision = startDeployment(
        undefined,
        {
          ...start,
          environmentId: target.environmentId,
          externalId: "different",
          coverageDecisionId: proof.proof.id,
        },
        {
          id: "forged",
          workspaceId: tx.workspaceId,
          serviceId: target.serviceId,
          environmentId: target.environmentId,
          tokenId: grant.id,
          mappedDeployerId: responderIdSchema.parse("primary"),
          timeoutSeconds: target.timeoutSeconds,
        },
        tx.now,
      );
      if (decision.state !== "changed") throw new Error("expected transition");
      await tx.deployments.insert({
        targetId: target.id,
        deployment: decision.deployment,
        policy: await tx.targets.routing(target.id),
      });
    }),
    { code: "invalid_coverage" },
  );
  assert.equal((await stored(f)).items.length, 0);
  await commands(f).start(grant.token, "start", {
    ...start,
    coverageDecisionId: proof.proof.id,
  });
  await assert.rejects(
    f.repository.transaction(f.actor.workspaceId, async (tx) => {
      const receipt = (await tx.receipts.get("target", "start"))!;
      if (receipt.result.state === "rejected")
        throw new Error("expected receipt");
      await tx.receipts.insert({
        ...receipt,
        key: "forged-receipt",
        result: { ...receipt.result, coverageDecisionId: "different" },
      });
    }),
    { code: "invalid_receipt" },
  );
});
test("preflight shares start admission capacity and sanitizes invalid environment requests", async () => {
  const f = await fixture(),
    grant = await f.issue(),
    cmd = commands(f);
  const proof = await f.service.preflight(grant.token, "first", input);
  let release!: (value: typeof proof) => void;
  const pending = new Promise<typeof proof>((resolve) => {
    release = resolve;
  });
  const http = new DeploymentHttp(
    {
      start: cmd.start.bind(cmd),
      finish: cmd.finish.bind(cmd),
      preflight: () => pending,
    },
    () => true,
    1,
  );
  const request = {
    authorization: `Bearer ${grant.token}`,
    contentType: "application/json",
    idempotencyKey: "preflight",
    body: new TextEncoder().encode(JSON.stringify(input)),
  };
  const inflight = http.preflight(request);
  assert.deepEqual(await http.start(request), {
    status: 429,
    body: { error: "busy" },
  });
  release(proof);
  assert.deepEqual(await inflight, { status: 200, body: proof });
  const actual = new DeploymentHttp({
    start: cmd.start.bind(cmd),
    finish: cmd.finish.bind(cmd),
    preflight: f.service.preflight.bind(f.service),
  });
  assert.deepEqual(
    await actual.preflight({
      ...request,
      body: new TextEncoder().encode(
        JSON.stringify({ ...input, environmentId: "other" }),
      ),
    }),
    { status: 400, body: { error: "invalid_input" } },
  );
  const read = await f.issue(["deployment:read"]);
  assert.deepEqual(
    await actual.preflight({
      ...request,
      authorization: `Bearer ${read.token}`,
    }),
    { status: 401, body: { error: "invalid_token" } },
  );
  assert.deepEqual(await new DeploymentHttp(cmd).preflight(request), {
    status: 503,
    body: { error: "unavailable" },
  });
});
