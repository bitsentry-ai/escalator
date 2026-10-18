import test from "node:test";
import assert from "node:assert/strict";
import { DeploymentManagement } from "../src/application/deploy/management.js";
import {
  DeploymentAccess,
  deploymentTokenDigest,
} from "../src/application/deploy/access.js";
import { timeoutDeployment } from "../src/domain/deploy/lifecycle.js";
import { DeploymentCommands } from "../src/application/deploy/commands.js";
import { MemoryDeploymentRepository } from "./conformance/memory-deployments.js";
import { seedDeploymentFixture } from "./conformance/deployments.js";
import {
  workspaceIdSchema,
  responderIdSchema,
  environmentSchema,
  responderSchema,
  type Actor,
  type DeploymentToken,
} from "../src/contracts/index.js";
import type { DeploymentRepository } from "../src/application/deploy/ports.js";
const initial = "2026-10-04T00:00:00.000Z";
async function fixture() {
  let at = Date.parse(initial),
    sequence = 0;
  const repository = new MemoryDeploymentRepository({
    now: () => new Date(at),
  });
  const actor: Actor = {
    workspaceId: workspaceIdSchema.parse("deploy-workspace"),
    responderId: responderIdSchema.parse("primary"),
    role: "administrator",
  };
  await seedDeploymentFixture(
    {
      repository,
      configuration: repository.configuration,
      work: repository.work,
      dispose: async () => {},
    },
    actor.workspaceId,
  );
  const ids = () => `created-${++sequence}`;
  const management = new DeploymentManagement(repository, ids);
  const access = new DeploymentAccess(
    repository,
    (scope) => scope === actor.workspaceId,
  );
  return {
    repository,
    actor,
    ids,
    management,
    access,
    commands: new DeploymentCommands(access, ids),
    advance: (ms: number) => {
      at += ms;
    },
    issue: (
      capabilities: DeploymentToken["capabilities"] = [
        "deployment:read",
        "deployment:write",
      ],
    ) =>
      management.issueToken(actor, {
        targetId: "target",
        capabilities,
        ttlSeconds: 60,
        mappedDeployerId: responderIdSchema.parse("primary"),
      }),
  };
}
const start = {
  version: 1 as const,
  source: "ci",
  externalId: "run-1",
  environmentId: "prod",
  actor: "untrusted-actor",
  commit: "abc123",
  artifact: null,
  occurredAt: initial,
};
const finish = {
  version: 1 as const,
  source: "ci",
  externalId: "run-1",
  environmentId: "prod",
  actor: "ci",
  outcome: "SUCCEEDED" as const,
  occurredAt: initial,
};
const acceptedId = (
  value: Awaited<ReturnType<DeploymentCommands["start"]>>,
) => {
  if (value.state === "rejected") throw new Error("Expected accepted command");
  return value.deploymentId;
};

test("managed grants contain hashes at rest and redact tokens/digests from inventory and audit", async () => {
  const f = await fixture(),
    issued = await f.issue();
  assert.match(issued.token, /^edp_[A-Za-z0-9_-]{43}$/);
  assert.equal("tokenHash" in issued, false);
  const hash = deploymentTokenDigest(issued.token)!;
  const stored = await f.repository.transaction(f.actor.workspaceId, (tx) =>
    tx.tokens.get("target", hash),
  );
  assert.equal(stored?.tokenHash, hash);
  assert.equal("token" in stored!, false);
  const inventory = await f.management.listTokens(f.actor, {
    targetId: "target",
  });
  const audit = await f.repository.transaction(f.actor.workspaceId, (tx) =>
    tx.audit.list({ limit: 100 }),
  );
  const serialized = JSON.stringify({ inventory, audit });
  assert.equal(serialized.includes(issued.token), false);
  assert.equal(serialized.includes(hash), false);
});

test("read-only grants cannot start, finish, or replay writes; write-only grants cannot read", async () => {
  const f = await fixture(),
    write = await f.issue(["deployment:write"]),
    read = await f.issue(["deployment:read"]);
  const created = await f.commands.start(write.token, "first", start),
    id = acceptedId(created);
  await assert.rejects(f.commands.start(read.token, "first", start), {
    code: "invalid_token",
  });
  await assert.rejects(f.commands.finish(read.token, id, "finish", finish), {
    code: "invalid_token",
  });
  await assert.rejects(f.commands.get(write.token, id), {
    code: "invalid_token",
  });
  assert.equal((await f.commands.get(read.token, id)).status, "STARTED");
});

test("the first command response survives completion and valid token rotation", async () => {
  const f = await fixture(),
    old = await f.issue();
  const created = await f.commands.start(old.token, "first", start),
    id = acceptedId(created);
  await f.commands.finish(old.token, id, "finish", finish);
  const rotated = await f.issue();
  await f.management.revokeToken(f.actor, { targetId: "target", id: old.id });
  await assert.rejects(f.commands.start(old.token, "first", start), {
    code: "invalid_token",
  });
  assert.deepEqual(
    await f.commands.start(rotated.token, "first", start),
    created,
  );
  const stored = await f.commands.get(rotated.token, id);
  assert.equal(stored.status, "SUCCEEDED");
  assert.equal(stored.tokenId, old.id);
  assert.equal(stored.mappedDeployerId, "primary");
  assert.equal(stored.actor, "untrusted-actor");
  assert.equal(
    (await f.commands.start(rotated.token, "new-key", start)).state,
    "duplicate",
  );
  assert.equal(
    (
      await f.repository.transaction(f.actor.workspaceId, (tx) =>
        tx.deployments.list("target", { limit: 10 }),
      )
    ).items.length,
    1,
  );
});

test("idempotency keys reject changed bodies/actions and a missing start stays a deterministic rejection", async () => {
  const f = await fixture(),
    issued = await f.issue();
  const created = await f.commands.start(issued.token, "one", start),
    id = acceptedId(created);
  await assert.rejects(
    f.commands.start(issued.token, "one", { ...start, commit: "different" }),
    { code: "idempotency_conflict" },
  );
  await assert.rejects(f.commands.finish(issued.token, id, "one", finish), {
    code: "idempotency_conflict",
  });
  const absent = await f.commands.finish(
    issued.token,
    "missing",
    "absent",
    finish,
  );
  assert.deepEqual(absent, {
    state: "rejected",
    reason: "missing_start",
    deploymentId: null,
  });
  assert.deepEqual(
    await f.commands.finish(issued.token, "missing", "absent", finish),
    absent,
  );
  assert.equal((await f.commands.get(issued.token, id)).status, "STARTED");
});

test("expired grants and disabled targets reject reads and stored receipt replays", async () => {
  const f = await fixture(),
    issued = await f.issue();
  const created = await f.commands.start(issued.token, "one", start),
    id = acceptedId(created);
  f.advance(60000);
  await assert.rejects(f.commands.start(issued.token, "one", start), {
    code: "invalid_token",
  });
  await assert.rejects(f.commands.get(issued.token, id), {
    code: "invalid_token",
  });
  const fresh = await f.issue();
  await f.management.update(f.actor, {
    id: "target",
    expectedRevision: 1,
    name: "Disabled",
    enabled: false,
    policyId: "policy",
    timeoutSeconds: 600,
  });
  await assert.rejects(f.commands.start(fresh.token, "one", start), {
    code: "invalid_token",
  });
  await assert.rejects(f.commands.get(fresh.token, id), {
    code: "invalid_token",
  });
});

test("scope gating and malformed tokens reject before scoped reads; request bodies cannot choose a workspace", async () => {
  const f = await fixture(),
    issued = await f.issue();
  const blocked = new DeploymentCommands(
    new DeploymentAccess(f.repository, () => false),
    f.ids,
  );
  await assert.rejects(blocked.start(issued.token, "one", start), {
    code: "invalid_token",
  });
  await assert.rejects(f.commands.start("invalid", "one", start), {
    code: "invalid_token",
  });
  await assert.rejects(
    f.commands.start(issued.token, "one", {
      ...start,
      workspaceId: "forged",
    } as typeof start),
  );
  assert.equal(
    (
      await f.commands.start(issued.token, "wrong-env", {
        ...start,
        environmentId: "foreign",
      })
    ).state,
    "rejected",
  );
  assert.equal(
    (
      await f.repository.transaction(f.actor.workspaceId, (tx) =>
        tx.deployments.list("target", { limit: 10 }),
      )
    ).items.length,
    0,
  );
});

test("audit failure rolls back deployment and receipt; the original request can succeed afterward", async () => {
  const f = await fixture(),
    issued = await f.issue();
  const failing: DeploymentRepository = {
    findTokenContext: (hash) => f.repository.findTokenContext(hash),
    transaction: (scope, work) =>
      f.repository.transaction(scope, (tx) =>
        work({
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
  const commands = new DeploymentCommands(
    new DeploymentAccess(failing, () => true),
    f.ids,
  );
  await assert.rejects(
    commands.start(issued.token, "one", start),
    /audit unavailable/,
  );
  await f.repository.transaction(f.actor.workspaceId, async (tx) => {
    assert.equal(await tx.receipts.get("target", "one"), undefined);
    assert.equal(
      (await tx.deployments.list("target", { limit: 10 })).items.length,
      0,
    );
  });
  assert.equal(
    (await f.commands.start(issued.token, "one", start)).state,
    "accepted",
  );
});

test("target administration denies responders before parsing or touching persistence", async () => {
  const repository: DeploymentRepository = {
    findTokenContext: async () => {
      throw new Error("unexpected DB");
    },
    transaction: async () => {
      throw new Error("unexpected DB");
    },
  };
  const manager = new DeploymentManagement(repository, () => "unused");
  const actor: Actor = {
    workspaceId: workspaceIdSchema.parse("org"),
    responderId: responderIdSchema.parse("responder"),
    role: "responder",
  };
  await assert.rejects(manager.issueToken(actor, {} as never), {
    code: "forbidden",
  });
  await assert.rejects(manager.create(actor, {} as never), {
    code: "forbidden",
  });
  await assert.rejects(manager.update(actor, {} as never), {
    code: "forbidden",
  });
  await assert.rejects(manager.revokeToken(actor, {} as never), {
    code: "forbidden",
  });
});

test("target creation and conditional edits share scoped policy validation and audit", async () => {
  const f = await fixture();
  await f.repository.transaction(f.actor.workspaceId, async (tx) => {
    await tx.environments.insert(
      environmentSchema.parse({
        id: "stage",
        workspaceId: f.actor.workspaceId,
        name: "Staging",
        key: "stage",
        isProduction: false,
        createdAt: tx.now,
        updatedAt: tx.now,
      }),
    );
  });
  const target = await f.management.create(f.actor, {
    name: "Stage",
    serviceId: "api",
    environmentId: "stage",
    policyId: "policy",
    timeoutSeconds: 300,
  });
  assert.equal(target.workspaceId, f.actor.workspaceId);
  assert.equal(target.enabled, true);
  const update = {
    id: target.id,
    expectedRevision: 1,
    name: "Renamed",
    enabled: false,
    policyId: "policy",
    timeoutSeconds: 600,
  };
  assert.equal((await f.management.update(f.actor, update)).revision, 2);
  await assert.rejects(f.management.update(f.actor, update), {
    code: "conflict",
  });
  await assert.rejects(
    f.management.update(f.actor, {
      ...update,
      expectedRevision: 2,
      workspaceId: "foreign",
    } as typeof update),
  );
  assert.equal(
    (await f.management.get(f.actor, { targetId: target.id })).name,
    "Renamed",
  );
  const events = await f.repository.transaction(f.actor.workspaceId, (tx) =>
    tx.audit.list({ limit: 100 }),
  );
  assert.deepEqual(events.items.map((value) => value.action).sort(), [
    "deployment.target.created",
    "deployment.target.updated",
  ]);
});

test("issuance failure leaves no grant and mapping requires a scoped responder who can acknowledge", async () => {
  const f = await fixture();
  const failing: DeploymentRepository = {
    findTokenContext: (hash) => f.repository.findTokenContext(hash),
    transaction: (scope, work) =>
      f.repository.transaction(scope, (tx) =>
        work({
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
  const manager = new DeploymentManagement(failing, f.ids);
  const before = await f.management.listTokens(f.actor, { targetId: "target" });
  await assert.rejects(
    manager.issueToken(f.actor, {
      targetId: "target",
      capabilities: ["deployment:write"],
    }),
    /audit unavailable/,
  );
  assert.deepEqual(
    await f.management.listTokens(f.actor, { targetId: "target" }),
    before,
  );
  await f.repository.transaction(f.actor.workspaceId, async (tx) => {
    await tx.responders.insert(
      responderSchema.parse({
        id: "viewer",
        workspaceId: f.actor.workspaceId,
        hostUserId: "viewer",
        displayName: "Viewer",
        role: "viewer",
        timeZone: "UTC",
        enabled: true,
        createdAt: tx.now,
        updatedAt: tx.now,
      }),
    );
  });
  const foreign = workspaceIdSchema.parse("foreign-workspace");
  await f.repository.transaction(foreign, async (tx) => {
    await tx.workspace.insert({
      id: foreign,
      name: "Foreign",
      createdAt: tx.now,
      updatedAt: tx.now,
    });
    await tx.responders.insert(
      responderSchema.parse({
        id: "foreign-only",
        workspaceId: foreign,
        hostUserId: "foreign-user",
        displayName: "Foreign",
        role: "responder",
        timeZone: "UTC",
        enabled: true,
        createdAt: tx.now,
        updatedAt: tx.now,
      }),
    );
  });
  for (const mappedDeployerId of ["viewer", "foreign-only"])
    await assert.rejects(
      f.management.issueToken(f.actor, {
        targetId: "target",
        capabilities: ["deployment:write"],
        mappedDeployerId,
      }),
      { code: "invalid_responder" },
    );
  await assert.rejects(
    f.management.issueToken(f.actor, {
      targetId: "target",
      capabilities: ["deployment:write"],
      ttlSeconds: 0,
    }),
  );
  await assert.rejects(
    f.management.issueToken(f.actor, {
      targetId: "target",
      capabilities: ["deployment:write", "deployment:write"],
    }),
  );
});

test("concurrent duplicate starts return one stored response and one deployment", async () => {
  const f = await fixture(),
    grant = await f.issue();
  const [a, b] = await Promise.all([
    f.commands.start(grant.token, "same", start),
    f.commands.start(grant.token, "same", start),
  ]);
  assert.deepEqual(a, b);
  await f.repository.transaction(f.actor.workspaceId, async (tx) => {
    assert.equal(
      (await tx.deployments.list("target", { limit: 10 })).items.length,
      1,
    );
    assert.equal(
      (await tx.audit.list({ limit: 100 })).items.filter(
        (value) => value.action === "deployment.start.accepted",
      ).length,
      1,
    );
  });
});

test("late finish records evidence without reversing a persisted timeout", async () => {
  const f = await fixture(),
    grant = await f.issue();
  const id = acceptedId(await f.commands.start(grant.token, "one", start));
  // The test grant expires before the timeout; rotation must not rewrite the original deployment.
  f.advance(600000);
  await f.repository.transaction(f.actor.workspaceId, async (tx) => {
    const current = (await tx.deployments.get("target", id))!.deployment;
    const decision = timeoutDeployment(current, await tx.currentTime());
    assert.equal(decision.state, "changed");
    if (decision.state === "changed")
      await tx.deployments.replace(
        "target",
        decision.deployment,
        current.revision,
      );
  });
  const rotated = await f.issue();
  const late = await f.commands.finish(rotated.token, id, "late", {
    ...finish,
    occurredAt: "2026-10-04T00:10:00.000Z",
  });
  assert.equal(late.state, "accepted");
  const stored = await f.commands.get(rotated.token, id);
  assert.equal(stored.status, "TIMED_OUT");
  assert.equal(stored.finish?.outcome, "SUCCEEDED");
  assert.equal(stored.timedOutAt, "2026-10-04T00:10:00.000Z");
  assert.equal(stored.tokenId, grant.id);
});

test("chronology rejections stay retryable with the same key once database time catches up", async () => {
  const f = await fixture(),
    grant = await f.issue();
  const early = { ...start, occurredAt: "2026-10-04T00:00:20.000Z" };
  assert.deepEqual(await f.commands.start(grant.token, "skewed", early), {
    state: "rejected",
    reason: "chronology",
    deploymentId: null,
  });
  f.advance(20000);
  const created = await f.commands.start(grant.token, "skewed", early),
    id = acceptedId(created);
  assert.equal(created.state, "accepted");
  const skewed = { ...finish, occurredAt: "2026-10-04T00:00:40.000Z" };
  assert.equal(
    (await f.commands.finish(grant.token, id, "done", skewed)).state,
    "rejected",
  );
  f.advance(20000);
  assert.equal(
    (await f.commands.finish(grant.token, id, "done", skewed)).state,
    "accepted",
  );
  assert.equal((await f.commands.get(grant.token, id)).status, "SUCCEEDED");
  const audit = await f.repository.transaction(f.actor.workspaceId, (tx) =>
    tx.audit.list({ limit: 100 }),
  );
  assert.equal(
    audit.items.filter((entry) => entry.metadata?.reason === "chronology")
      .length,
    2,
  );
});

test("disabled services and unapproved workspaces cannot invoke the authenticated callback", async () => {
  const f = await fixture(),
    grant = await f.issue();
  const disabled: DeploymentRepository = {
    findTokenContext: (hash) => f.repository.findTokenContext(hash),
    transaction: (scope, work) =>
      f.repository.transaction(scope, (tx) =>
        work({
          ...tx,
          services: {
            ...tx.services,
            get: async (id) => {
              const value = await tx.services.get(id);
              return value ? { ...value, enabled: false } : undefined;
            },
          },
        }),
      ),
  };
  const callback = async () => {
    throw new Error("unexpected callback");
  };
  await assert.rejects(
    new DeploymentAccess(disabled, () => true).run(
      grant.token,
      "deployment:read",
      callback,
    ),
    { code: "invalid_token" },
  );
  const blocked: DeploymentRepository = {
    findTokenContext: (hash) => f.repository.findTokenContext(hash),
    transaction: async () => {
      throw new Error("unexpected scoped read");
    },
  };
  await assert.rejects(
    new DeploymentAccess(blocked, () => false).run(
      grant.token,
      "deployment:read",
      callback,
    ),
    { code: "invalid_token" },
  );
});
