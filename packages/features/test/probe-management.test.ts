import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  workspaceIdSchema,
  responderIdSchema,
  createProbeSchema,
  type Actor,
  type Probe,
} from "../src/contracts/index.js";
import { ProbeManagement } from "../src/application/probes/management.js";
import {
  defaultProbeLimits,
  type ProbeLimits,
} from "../src/application/probes/capacity.js";
import type { ProbeRepository } from "../src/application/probes/ports.js";
import { ProbeDestinationPolicy } from "../src/adapters/probes/policy.js";
import { MemoryProbeRepository } from "./conformance/memory-probes.js";
import { seedSignalFixture } from "./conformance/signals.js";
const input = createProbeSchema.parse({
  name: "Health",
  serviceId: "service",
  environmentId: "production",
  enabled: true,
  intervalSeconds: 60,
  critical: true,
  failureThreshold: 1,
  recoveryThreshold: 2,
  config: {
    url: "https://example.test/health",
    method: "GET",
    body: null,
    authSecretId: null,
    timeoutMs: 1000,
    maxResponseBytes: 1000,
    assertions: { status: [200], contains: null, json: [] },
    syntheticWrite: null,
  },
});
const destinations = new ProbeDestinationPolicy({
  hosts: [{ hostname: "example.test", ports: [443] }],
  privateCidrs: [],
});
function updateInput(probe: Probe) {
  return {
    id: probe.id,
    expectedVersion: probe.version,
    name: probe.name,
    enabled: probe.enabled,
    intervalSeconds: probe.intervalSeconds,
    critical: probe.critical,
    failureThreshold: probe.failureThreshold,
    recoveryThreshold: probe.recoveryThreshold,
    config: probe.config,
  };
}
async function fixture(limits: ProbeLimits = { ...defaultProbeLimits }) {
  const repository = new MemoryProbeRepository();
  const actor: Actor = {
    workspaceId: workspaceIdSchema.parse("probes-admin"),
    responderId: responderIdSchema.parse("admin"),
    role: "administrator",
  };
  await repository.transaction(actor.workspaceId, seedSignalFixture);
  return {
    repository,
    actor,
    management: new ProbeManagement(
      repository,
      randomUUID,
      destinations,
      limits,
    ),
  };
}
test("probe configuration uses trusted scope and audits source, version and schedule changes atomically", async () => {
  const f = await fixture();
  const probe = await f.management.create(f.actor, input);
  assert.equal(probe.workspaceId, f.actor.workspaceId);
  assert.ok(
    (await f.management.get(f.actor, { id: probe.id })).schedule?.jobId,
  );
  const updated = await f.management.update(f.actor, {
    ...updateInput(probe),
    name: "Renamed",
  });
  assert.equal(updated.version, 2);
  await f.management.disable(f.actor, { id: probe.id, expectedVersion: 2 });
  await f.repository.transaction(f.actor.workspaceId, async (tx) => {
    const source = (await tx.sources.get(probe.sourceId))!;
    assert.equal(source.name, "Renamed");
    assert.equal(source.enabled, false);
    assert.equal((await tx.probes.schedule(probe.id))?.jobId, null);
    const audit = (await tx.audit.list({ limit: 100 })).items;
    assert.equal(audit.length, 3);
    assert.ok(
      audit.every(
        (event) => !JSON.stringify(event.metadata).includes("example.test"),
      ),
    );
  });
});
test("viewers and responders can inspect probes but cannot create or disable them", async () => {
  const f = await fixture();
  const probe = await f.management.create(f.actor, input);
  for (const role of ["viewer", "responder"] as const) {
    const actor = { ...f.actor, role };
    assert.equal((await f.management.list(actor)).items.length, 1);
    await assert.rejects(f.management.create(actor, input), {
      code: "forbidden",
    });
    await assert.rejects(
      f.management.disable(actor, { id: probe.id, expectedVersion: 1 }),
      { code: "forbidden" },
    );
  }
  await assert.rejects(
    f.management.create(f.actor, { ...input, workspaceId: "other" } as never),
  );
  await assert.rejects(
    f.management.get(
      { ...f.actor, workspaceId: workspaceIdSchema.parse("other") },
      { id: probe.id },
    ),
    { code: "not_found" },
  );
});
test("parallel creations cannot overbook configured capacity and same-version edits have one winner", async () => {
  const f = await fixture({ maxActive: 1, maxConfigured: 2, concurrency: 1 });
  const attempts = await Promise.allSettled([
    f.management.create(f.actor, input),
    f.management.create(f.actor, input),
  ]);
  assert.equal(
    attempts.filter((value) => value.status === "fulfilled").length,
    1,
  );
  assert.equal(
    attempts.filter((value) => value.status === "rejected").length,
    1,
  );
  const probe = (await f.management.list(f.actor)).items[0];
  const edits = await Promise.allSettled([
    f.management.update(f.actor, { ...updateInput(probe), name: "One" }),
    f.management.update(f.actor, { ...updateInput(probe), name: "Two" }),
  ]);
  assert.equal(edits.filter((value) => value.status === "fulfilled").length, 1);
  assert.equal(edits.filter((value) => value.status === "rejected").length, 1);
});
test("timeout-weighted request budget rejects overload but permits disabling after limits tighten", async () => {
  const f = await fixture({ maxActive: 10, maxConfigured: 20, concurrency: 1 });
  const slow = { ...input, config: { ...input.config, timeoutMs: 10000 } };
  for (let index = 0; index < 4; index++)
    await f.management.create(f.actor, slow);
  await assert.rejects(f.management.create(f.actor, slow), {
    code: "request_budget",
  });
  const probe = (await f.management.list(f.actor)).items[0];
  const tightened = new ProbeManagement(
    f.repository,
    randomUUID,
    {
      target: () => {
        throw new Error("policy changed");
      },
    },
    { maxActive: 1, maxConfigured: 1, concurrency: 1 },
  );
  await tightened.disable(f.actor, { id: probe.id, expectedVersion: 1 });
  assert.equal(
    (await tightened.get(f.actor, { id: probe.id })).probe.enabled,
    false,
  );
});
test("enabled probes require deployment-approved destinations and authenticated HTTPS", async () => {
  const f = await fixture();
  await assert.rejects(
    f.management.create(f.actor, {
      ...input,
      config: { ...input.config, url: "https://other.test" },
    }),
    { code: "destination_denied" },
  );
  const pending = await f.management.create(f.actor, {
    ...input,
    enabled: false,
    config: { ...input.config, url: "https://other.test" },
  });
  await assert.rejects(
    f.management.update(f.actor, { ...updateInput(pending), enabled: true }),
    { code: "destination_denied" },
  );
  await assert.rejects(
    f.management.create(f.actor, {
      ...input,
      config: {
        ...input.config,
        url: "http://example.test",
        authSecretId: "fixture-secret",
      },
    }),
    { code: "destination_denied" },
  );
});
test("audit failure rolls back configuration, source and durable job creation", async () => {
  const f = await fixture();
  const failing: ProbeRepository = {
    transaction: (scope, run) =>
      f.repository.transaction(scope, (tx) =>
        run({
          ...tx,
          audit: {
            ...tx.audit,
            append: async () => {
              throw new Error("audit failed");
            },
          },
        }),
      ),
  };
  const management = new ProbeManagement(failing, randomUUID, destinations);
  await assert.rejects(management.create(f.actor, input));
  assert.equal((await f.management.list(f.actor)).items.length, 0);
  assert.equal(
    await f.repository.signals.foundation.claim({
      workspaceId: f.actor.workspaceId,
      queue: "job",
      token: randomUUID(),
      leaseMs: 30000,
      kinds: ["probe.execute"],
    }),
    undefined,
  );
  assert.equal(
    await f.repository.transaction(
      f.actor.workspaceId,
      async (tx) => (await tx.sources.list({ limit: 100 })).items.length,
    ),
    1,
  );
});
test("capacity locks reject acquisition after a probe row lock", async () => {
  const f = await fixture();
  const probe = await f.management.create(f.actor, input);
  await assert.rejects(
    f.repository.transaction(f.actor.workspaceId, async (tx) => {
      await tx.probes.lock(probe.id);
      await tx.probes.lockCapacity();
    }),
    { code: "invalid_lock_order" },
  );
});

test("destination policy uses authenticated workspace scope rather than a shared tenant allowlist", async () => {
  const f = await fixture();
  const other = {
    ...f.actor,
    workspaceId: workspaceIdSchema.parse("other-org"),
  };
  await f.repository.transaction(other.workspaceId, seedSignalFixture);
  const management = new ProbeManagement(f.repository, randomUUID, {
    target(url, scope) {
      const expected =
        scope === f.actor.workspaceId ? "example.test" : "other.test";
      if (new URL(url).hostname !== expected)
        throw new Error("Destination denied");
    },
  });
  await management.create(f.actor, input);
  await assert.rejects(management.create(other, input), {
    code: "destination_denied",
  });
  const probe = await management.create(other, {
    ...input,
    config: { ...input.config, url: "https://other.test/health" },
  });
  assert.equal(probe.workspaceId, other.workspaceId);
});
