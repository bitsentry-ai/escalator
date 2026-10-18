import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  workspaceIdSchema,
  responderIdSchema,
  createMetricSchema,
  type Actor,
  type MetricMonitor,
} from "../src/contracts/index.js";
import { MetricManagement } from "../src/application/metrics/management.js";
import {
  defaultMetricLimits,
  type MetricLimits,
} from "../src/application/metrics/capacity.js";
import type { MetricsRepository } from "../src/application/metrics/ports.js";
import { ProbeDestinationPolicy } from "../src/adapters/probes/policy.js";
import { MemoryMetricsRepository } from "./conformance/memory-metrics.js";
import { seedSignalFixture } from "./conformance/signals.js";
const input = createMetricSchema.parse({
  name: "Health",
  serviceId: "service",
  environmentId: "production",
  enabled: true,
  stepSeconds: 60,
  query: {
    connection: {
      provider: "prometheus",
      baseUrl: "https://example.test",
      authSecretId: null,
    },
    requestsQuery: "sum(increase(requests_total[60s]))",
    errorsQuery: "sum(increase(errors_total[60s]))",
  },
  rule: {
    windowSeconds: 120,
    minimumSamples: 2,
    minimumRequests: 100,
    errorRateFloor: 0.05,
  },
});
const destinations = new ProbeDestinationPolicy({
  hosts: [{ hostname: "example.test", ports: [443] }],
  privateCidrs: [],
});
function updateInput(metric: MetricMonitor) {
  return {
    id: metric.id,
    expectedVersion: metric.version,
    name: metric.name,
    enabled: metric.enabled,
    stepSeconds: metric.stepSeconds,
    query: metric.query,
    rule: metric.rule,
  };
}
async function fixture(limits: MetricLimits = { ...defaultMetricLimits }) {
  const repository = new MemoryMetricsRepository();
  const actor: Actor = {
    workspaceId: workspaceIdSchema.parse("metrics-admin"),
    responderId: responderIdSchema.parse("admin"),
    role: "administrator",
  };
  await repository.transaction(actor.workspaceId, seedSignalFixture);
  return {
    repository,
    actor,
    management: new MetricManagement(
      repository,
      randomUUID,
      destinations,
      limits,
    ),
  };
}
test("metric configuration uses trusted scope and audits source, version and schedule changes atomically", async () => {
  const f = await fixture();
  const metric = await f.management.create(f.actor, input);
  assert.equal(metric.workspaceId, f.actor.workspaceId);
  assert.ok(
    (await f.management.get(f.actor, { id: metric.id })).schedule?.jobId,
  );
  const updated = await f.management.update(f.actor, {
    ...updateInput(metric),
    name: "Renamed",
  });
  assert.equal(updated.version, 2);
  await f.management.disable(f.actor, { id: metric.id, expectedVersion: 2 });
  await f.repository.transaction(f.actor.workspaceId, async (tx) => {
    const source = (await tx.sources.get(metric.sourceId))!;
    assert.equal(source.name, "Renamed");
    assert.equal(source.enabled, false);
    assert.equal((await tx.metrics.schedule(metric.id))?.jobId, null);
    const audit = (await tx.audit.list({ limit: 100 })).items;
    assert.equal(audit.length, 3);
    assert.ok(
      audit.every(
        (event) => !JSON.stringify(event.metadata).includes("example.test"),
      ),
    );
  });
});
test("viewers and responders can inspect metrics but cannot create or disable them", async () => {
  const f = await fixture();
  const metric = await f.management.create(f.actor, input);
  for (const role of ["viewer", "responder"] as const) {
    const actor = { ...f.actor, role };
    assert.equal((await f.management.list(actor)).items.length, 1);
    await assert.rejects(f.management.create(actor, input), {
      code: "forbidden",
    });
    await assert.rejects(
      f.management.disable(actor, { id: metric.id, expectedVersion: 1 }),
      { code: "forbidden" },
    );
  }
  await assert.rejects(
    f.management.create(f.actor, { ...input, workspaceId: "other" } as never),
  );
  await assert.rejects(
    f.management.get(
      { ...f.actor, workspaceId: workspaceIdSchema.parse("other") },
      { id: metric.id },
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
  const metric = (await f.management.list(f.actor)).items[0];
  const edits = await Promise.allSettled([
    f.management.update(f.actor, { ...updateInput(metric), name: "One" }),
    f.management.update(f.actor, { ...updateInput(metric), name: "Two" }),
  ]);
  assert.equal(edits.filter((value) => value.status === "fulfilled").length, 1);
  assert.equal(edits.filter((value) => value.status === "rejected").length, 1);
});
test("timeout-weighted request budget rejects overload but permits disabling after limits tighten", async () => {
  const f = await fixture({ maxActive: 10, maxConfigured: 20, concurrency: 1 });
  const slow = input;
  for (let index = 0; index < 4; index++)
    await f.management.create(f.actor, slow);
  await assert.rejects(f.management.create(f.actor, slow), {
    code: "request_budget",
  });
  const metric = (await f.management.list(f.actor)).items[0];
  const tightened = new MetricManagement(
    f.repository,
    randomUUID,
    {
      target: () => {
        throw new Error("policy changed");
      },
    },
    { maxActive: 1, maxConfigured: 1, concurrency: 1 },
  );
  await tightened.disable(f.actor, { id: metric.id, expectedVersion: 1 });
  assert.equal(
    (await tightened.get(f.actor, { id: metric.id })).metric.enabled,
    false,
  );
});
test("enabled metrics require deployment-approved destinations and authenticated HTTPS", async () => {
  const f = await fixture();
  await assert.rejects(
    f.management.create(f.actor, {
      ...input,
      query: {
        ...input.query,
        connection: {
          ...input.query.connection,
          baseUrl: "https://other.test",
        },
      },
    }),
    { code: "destination_denied" },
  );
  const pending = await f.management.create(f.actor, {
    ...input,
    enabled: false,
    query: {
      ...input.query,
      connection: { ...input.query.connection, baseUrl: "https://other.test" },
    },
  });
  await assert.rejects(
    f.management.update(f.actor, { ...updateInput(pending), enabled: true }),
    { code: "destination_denied" },
  );
  await assert.rejects(
    f.management.create(f.actor, {
      ...input,
      query: {
        ...input.query,
        connection: {
          ...input.query.connection,
          baseUrl: "http://example.test",
          authSecretId: "fixture-secret",
        },
      },
    }),
    { code: "destination_denied" },
  );
});
test("audit failure rolls back configuration, source and durable job creation", async () => {
  const f = await fixture();
  const failing: MetricsRepository = {
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
  const management = new MetricManagement(failing, randomUUID, destinations);
  await assert.rejects(management.create(f.actor, input));
  assert.equal((await f.management.list(f.actor)).items.length, 0);
  assert.equal(
    await f.repository.signals.foundation.claim({
      workspaceId: f.actor.workspaceId,
      queue: "job",
      token: randomUUID(),
      leaseMs: 30000,
      kinds: ["metrics.poll"],
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
test("capacity locks reject acquisition after a metric row lock", async () => {
  const f = await fixture();
  const metric = await f.management.create(f.actor, input);
  await assert.rejects(
    f.repository.transaction(f.actor.workspaceId, async (tx) => {
      await tx.metrics.lock(metric.id);
      await tx.metrics.lockCapacity();
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
  const management = new MetricManagement(f.repository, randomUUID, {
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
  const metric = await management.create(other, {
    ...input,
    query: {
      ...input.query,
      connection: { ...input.query.connection, baseUrl: "https://other.test" },
    },
  });
  assert.equal(metric.workspaceId, other.workspaceId);
});

test("query and rule changes retain prior configuration and start a fresh sample window", async () => {
  const f = await fixture();
  const metric = await f.management.create(f.actor, input);
  const updated = await f.management.update(f.actor, {
    ...updateInput(metric),
    query: { ...metric.query, errorsQuery: "sum(increase(new_errors[60s]))" },
  });
  await f.repository.transaction(f.actor.workspaceId, async (tx) => {
    assert.equal(
      (await tx.metrics.version(metric.id, 1))?.query.errorsQuery,
      metric.query.errorsQuery,
    );
    assert.equal(
      (await tx.metrics.version(metric.id, 2))?.query.errorsQuery,
      updated.query.errorsQuery,
    );
    assert.equal(
      (await tx.metrics.schedule(metric.id))?.lastObservationId,
      null,
    );
    assert.equal((await tx.metrics.schedule(metric.id))?.monitorVersion, 2);
  });
  assert.equal(
    (await f.management.history(f.actor, { id: metric.id })).items.length,
    0,
  );
});
test("metric input rejects caller scope and incompatible rule windows; creation defaults disabled", async () => {
  assert.equal(
    createMetricSchema.parse({ ...input, enabled: undefined }).enabled,
    false,
  );
  const f = await fixture();
  await assert.rejects(
    f.management.create(f.actor, { ...input, stepSeconds: 90 }),
  );
  assert.equal((await f.management.list(f.actor)).items.length, 0);
});
