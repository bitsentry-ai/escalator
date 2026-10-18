import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  workspaceIdSchema,
  responderIdSchema,
  type Actor,
} from "../src/contracts/index.js";
import { DeploymentAccess } from "../src/application/deploy/access.js";
import { DeploymentWatchReader } from "../src/application/deploy/watch-read.js";
import { DeploymentWatchHttp } from "../src/application/deploy/watch-http.js";
import { DeploymentManagement } from "../src/application/deploy/management.js";
import { finishDeployment } from "../src/domain/deploy/lifecycle.js";
import { MemoryDeploymentWatchRepository } from "./conformance/memory-deployment-watches.js";
import {
  seedDeploymentFixture,
  fixtureDeployment,
} from "./conformance/deployments.js";

async function fixture() {
  let at = Date.parse("2026-10-05T00:00:00.000Z");
  const repository = new MemoryDeploymentWatchRepository({
    now: () => new Date(at),
  });
  const actor: Actor = {
    workspaceId: workspaceIdSchema.parse("watch-read"),
    responderId: responderIdSchema.parse("primary"),
    role: "administrator",
  };
  const f = {
    repository,
    configuration: repository.configuration,
    work: repository.work,
    dispose: async () => {},
  };
  await seedDeploymentFixture(f, actor.workspaceId);
  await repository.transaction(actor.workspaceId, async (tx) =>
    tx.deployments.insert(await fixtureDeployment(tx)),
  );
  const management = new DeploymentManagement(repository, randomUUID);
  const read = await management.issueToken(actor, {
    targetId: "target",
    capabilities: ["deployment:read"],
    ttlSeconds: 60,
  });
  const reader = new DeploymentWatchReader(
    new DeploymentAccess(repository, () => true),
  );
  const http = new DeploymentWatchHttp(reader);
  return {
    ...f,
    actor,
    management,
    reader,
    http,
    read,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

test("machine watch reads distinguish unfinished deployments and return the persisted watch without advancing it", async () => {
  const f = await fixture();
  const before = await f.reader.read(f.read.token, "deployment");
  assert.equal(before.watch, null);
  assert.equal(before.baselineAvailable, true);
  assert.equal("policy" in before, false);
  await f.repository.transaction(f.actor.workspaceId, async (tx) => {
    const entry = (await tx.deployments.get("target", "deployment"))!;
    const result = finishDeployment(
      entry.deployment,
      {
        version: 1,
        source: entry.deployment.source,
        externalId: entry.deployment.externalId,
        environmentId: entry.deployment.environmentId,
        actor: "ci",
        occurredAt: tx.now,
        outcome: "SUCCEEDED",
      },
      tx.now,
    );
    if (result.state !== "changed") throw new Error("Expected finish");
    await tx.deployments.replace(
      "target",
      result.deployment,
      entry.deployment.revision,
    );
    await tx.watches.initialize("target", "deployment");
  });
  const first = await f.reader.read(f.read.token, "deployment");
  f.advance(1000);
  const second = await f.reader.read(f.read.token, "deployment");
  assert.equal(first.watch?.verdict, "PENDING");
  assert.deepEqual(first, second);
  assert.ok(!JSON.stringify(first).includes(f.read.token));
  assert.ok(!JSON.stringify(first).includes("tokenHash"));
});

test("watch polls recheck revocation, expiry and deployment:read capability", async () => {
  const f = await fixture();
  const poll = (token: string) => f.http.read("deployment", `Bearer ${token}`);
  const writer = await f.management.issueToken(f.actor, {
    targetId: "target",
    capabilities: ["deployment:write"],
    ttlSeconds: 60,
  });
  assert.equal((await poll(writer.token)).status, 401);
  assert.equal((await poll(f.read.token)).status, 200);
  await f.management.revokeToken(f.actor, {
    targetId: "target",
    id: f.read.id,
  });
  assert.equal((await poll(f.read.token)).status, 401);
  const next = await f.management.issueToken(f.actor, {
    targetId: "target",
    capabilities: ["deployment:read"],
    ttlSeconds: 60,
  });
  f.advance(60001);
  assert.equal((await poll(next.token)).status, 401);
});

test("another workspace cannot use its valid grant to read this deployment", async () => {
  const f = await fixture();
  const actor = {
    ...f.actor,
    workspaceId: workspaceIdSchema.parse("other-watch"),
  };
  await seedDeploymentFixture(f, actor.workspaceId);
  const other = await f.management.issueToken(actor, {
    targetId: "target",
    capabilities: ["deployment:read"],
  });
  assert.deepEqual(await f.http.read("deployment", `Bearer ${other.token}`), {
    status: 404,
    body: { error: "not_found" },
  });
});

test("watch HTTP rejects invalid credentials and IDs before storage and fails closed without activation", async () => {
  let calls = 0;
  const reader = {
    read: async () => {
      calls++;
      throw new Error("private storage detail");
    },
  };
  const http = new DeploymentWatchHttp(reader);
  assert.equal((await http.read("deployment", undefined)).status, 401);
  assert.equal(
    (await http.read("", `Bearer edp_${"a".repeat(43)}`)).status,
    400,
  );
  assert.equal(calls, 0);
  assert.deepEqual(
    await http.read("deployment", `Bearer edp_${"a".repeat(43)}`),
    { status: 503, body: { error: "unavailable" } },
  );
  const disabled = new DeploymentWatchHttp(reader, () => false);
  assert.equal((await disabled.read("deployment")).status, 503);
  assert.equal(calls, 1);
  for (const limit of [0, 65, 1.5])
    assert.throws(() => new DeploymentWatchHttp(reader, () => true, limit));
});

test("bounded watch reads release admission after success and errors", async () => {
  const f = await fixture(),
    value = await f.reader.read(f.read.token, "deployment");
  let release!: () => void,
    fail = false;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reader = {
    read: async () => {
      await waiting;
      if (fail) throw new Error("private");
      return value;
    },
  };
  const http = new DeploymentWatchHttp(reader, () => true, 1);
  const auth = `Bearer ${f.read.token}`,
    first = http.read("deployment", auth);
  assert.equal((await http.read("deployment", auth)).status, 429);
  release();
  assert.equal((await first).status, 200);
  fail = true;
  assert.equal((await http.read("deployment", auth)).status, 503);
  fail = false;
  assert.equal((await http.read("deployment", auth)).status, 200);
});
