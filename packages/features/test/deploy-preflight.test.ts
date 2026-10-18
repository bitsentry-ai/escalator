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
test("preflight binds trusted identity, excludes the deployer and writes one immutable proof plus audit", async () => {
  const f = await fixture(),
    grant = await f.issue();
  const result = await f.service.preflight(grant.token, "key", input);
  assert.equal(result.decision, "allow");
  assert.deepEqual(result.eligibleResponderIds, ["peer"]);
  assert.equal(result.proof.binding.mappedDeployerId, "primary");
  assert.deepEqual(
    await f.service.preflight(grant.token, "key", input),
    result,
  );
  assert.deepEqual(
    await f.service.get(f.actor, {
      targetId: "target",
      decisionId: result.proof.id,
    }),
    result.proof,
  );
  const audits = (await f.audit()).items.filter(
    (row) => row.action === "deployment.coverage_evaluated",
  );
  assert.equal(audits.length, 1);
  assert.equal(JSON.stringify(audits).includes(grant.token), false);
  await assert.rejects(
    f.service.preflight(grant.token, "key", {
      ...input,
      externalId: "changed",
    }),
    { code: "idempotency_conflict" },
  );
});
test("retries do not renew expiry; a new key obtains a new decision", async () => {
  const f = await fixture(),
    grant = await f.issue();
  const first = await f.service.preflight(grant.token, "key", input);
  f.advance(120000);
  const expired = await f.service.preflight(grant.token, "key", input);
  assert.equal(expired.reason, "expired");
  assert.equal(expired.decision, "block");
  assert.deepEqual(expired.proof, first.proof);
  const next = await f.service.preflight(grant.token, "next", input);
  assert.equal(next.decision, "allow");
  assert.notEqual(next.proof.id, first.proof.id);
});
test("read grants, revoked grants and caller-supplied scope or override are rejected", async () => {
  const f = await fixture(),
    read = await f.issue(["deployment:read"]),
    write = await f.issue();
  await assert.rejects(f.service.preflight(read.token, "key", input), {
    code: "invalid_token",
  });
  for (const extra of [
    { workspaceId: "other" },
    { override: true },
    { mappedDeployerId: "peer" },
  ])
    await assert.rejects(
      f.service.preflight(write.token, "key", { ...input, ...extra }),
    );
  await assert.rejects(
    f.service.preflight(write.token, "key", {
      ...input,
      environmentId: "other",
    }),
    { code: "scope_violation" },
  );
  await f.management.revokeToken(f.actor, { targetId: "target", id: write.id });
  await assert.rejects(f.service.preflight(write.token, "key", input), {
    code: "invalid_token",
  });
});
test("changed target revision invalidates a historical proof without mutating it", async () => {
  const f = await fixture(),
    grant = await f.issue();
  const first = await f.service.preflight(grant.token, "key", input);
  await f.repository.transaction(f.actor.workspaceId, async (tx) => {
    const target = (await tx.targets.get("target"))!;
    await tx.targets.replace(
      {
        ...target,
        revision: target.revision + 1,
        updatedAt: await tx.currentTime(),
      },
      target.revision,
    );
  });
  const replay = await f.service.preflight(grant.token, "key", input);
  assert.equal(replay.reason, "stale");
  assert.equal(replay.decision, "block");
  assert.deepEqual(replay.proof, first.proof);
});
test("unmapped deployer blocks; a live authorized reasoned override creates a separate audited proof", async () => {
  const f = await fixture(),
    grant = await f.issue(["deployment:write"], null);
  const first = await f.service.preflight(grant.token, "key", input);
  assert.equal(first.reason, "unmapped_deployer");
  const request = {
    targetId: "target",
    decisionId: first.proof.id,
    key: "override",
    reason: "Emergency operator coverage confirmed",
  };
  const allowed = await f.service.override(f.actor, request);
  assert.equal(allowed.reason, "override");
  assert.equal(allowed.decision, "allow");
  assert.notEqual(allowed.proof.id, first.proof.id);
  assert.deepEqual(await f.service.override(f.actor, request), allowed);
  assert.equal(
    (
      await f.service.get(f.actor, {
        targetId: "target",
        decisionId: first.proof.id,
      })
    ).override,
    null,
  );
  const audit = (await f.audit()).items.filter(
    (row) => row.action === "deployment.coverage_overridden",
  );
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.metadata.previousDecisionId, first.proof.id);
  await assert.rejects(
    f.service.override(f.actor, { ...request, reason: "Changed reason" }),
    { code: "idempotency_conflict" },
  );
  await assert.rejects(
    f.service.override(f.actor, { ...request, key: "blank", reason: "   " }),
  );
});
test("override checks persisted authority and scope, not only the session role", async () => {
  const f = await fixture(),
    grant = await f.issue();
  const first = await f.service.preflight(grant.token, "key", input);
  const request = {
    targetId: "target",
    decisionId: first.proof.id,
    key: "override",
    reason: "Emergency",
  };
  await assert.rejects(
    f.service.override({ ...f.actor, role: "viewer" }, request),
    { code: "forbidden" },
  );
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
  const service = new DeploymentPreflight(revoked, f.ids, () => true);
  await assert.rejects(service.override(f.actor, request), {
    code: "forbidden",
  });
  await assert.rejects(
    service.get(f.actor, { targetId: "target", decisionId: first.proof.id }),
    { code: "forbidden" },
  );
});
test("rollout disable blocks new machine decisions and overrides but preserves authorized history reads", async () => {
  const f = await fixture(),
    grant = await f.issue();
  const first = await f.service.preflight(grant.token, "key", input);
  f.disable();
  await assert.rejects(f.service.preflight(grant.token, "key", input), {
    code: "invalid_token",
  });
  await assert.rejects(
    f.service.override(f.actor, {
      targetId: "target",
      decisionId: first.proof.id,
      key: "override",
      reason: "Emergency",
    }),
    { code: "forbidden" },
  );
  assert.deepEqual(
    await f.service.get(f.actor, {
      targetId: "target",
      decisionId: first.proof.id,
    }),
    first.proof,
  );
});
test("audit failure rolls back proof insertion and unavailable storage cannot allow a deploy", async () => {
  const f = await fixture(),
    grant = await f.issue();
  const broken: CoverageRepository = {
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
  const service = new DeploymentPreflight(broken, f.ids, () => true);
  await assert.rejects(
    service.preflight(grant.token, "key", input),
    /audit unavailable/,
  );
  assert.equal(
    await f.repository.transaction(f.actor.workspaceId, (tx) =>
      tx.coverage.find("target", "key"),
    ),
    undefined,
  );
  assert.equal(
    (await f.service.preflight(grant.token, "key", input)).decision,
    "allow",
  );
  const unavailable = new DeploymentPreflight(
    {
      ...broken,
      transaction: async () => {
        throw new Error("database unavailable");
      },
    },
    f.ids,
    () => true,
  );
  await assert.rejects(
    unavailable.preflight(grant.token, "other", input),
    /database unavailable/,
  );
});
test("current evidence changes block replay even inside the two-minute lifetime", async () => {
  const f = await fixture(),
    grant = await f.issue();
  const first = await f.service.preflight(grant.token, "key", input);
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
  const replay = await f.service.preflight(grant.token, "key", input);
  assert.equal(replay.reason, "stale");
  assert.equal(replay.decision, "block");
  assert.deepEqual(replay.proof, first.proof);
  const next = await f.service.preflight(grant.token, "next", input);
  assert.equal(next.reason, "no_declared_coverage");
  assert.equal(next.decision, "block");
});
test("rotated grants cannot reuse another mapped deployer's preflight command identity", async () => {
  const f = await fixture(),
    primary = await f.issue(),
    peer = await f.issue(["deployment:write"], responderIdSchema.parse("peer"));
  await f.service.preflight(primary.token, "key", input);
  await assert.rejects(f.service.preflight(peer.token, "key", input), {
    code: "idempotency_conflict",
  });
});
