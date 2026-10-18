import { retentionFixture } from "../retention/runtime-fixture.js";
import { PostgresJobsRuntime } from "../../src/platform/jobs/postgres-jobs.runtime.js";
import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { Response } from "express";
import {
  HealthDeployment,
  OperationalHealthHttp,
  DurableWorkScheduler,
  WatchdogCoordinator,
  RetentionCoordinator,
  ProbeDeployment,
  MetricDeployment,
} from "@bitsentry-escalator/features/application";
import { workspaceIdSchema } from "@bitsentry-escalator/features/contracts";
import { PagingModule } from "../../src/features/paging/paging.module.js";
import { standalonePagingRuntime } from "../../src/features/paging/runtime.js";
import { OperationalHealthController } from "../../src/platform/health/health.controller.js";
import type { StandaloneDatabase } from "../../src/platform/database/database.module.js";
import { SecretKeyRing } from "../../src/platform/secrets/keyring.js";
const token = Buffer.alloc(32, 42).toString("base64url");
const digest = createHash("sha256").update(token).digest("hex");
const scope = workspaceIdSchema.parse("local-health");
const configuration = {
  readinessTokenSha256: digest,
  watchdog: { secretId: "watchdog-secret", intervalSeconds: 60 },
};
const ready = {
  ready: true,
  reasons: [],
  databaseNow: "2026-10-03T00:00:00.000Z",
  schedulerMaxAgeMs: 0,
  lagMs: { jobs: null, outbox: null, paging: null },
};
test("standalone health module selects only the configured local workspace", async () => {
  const providers = Reflect.getMetadata("providers", PagingModule) as {
    provide: unknown;
    useFactory: (...args: unknown[]) => unknown;
  }[];
  const provider = providers.find((p) => p.provide === OperationalHealthHttp)!;
  const http = provider.useFactory(
    { workspaceId: scope },
    { health: { check: async () => ready } },
    new HealthDeployment(configuration),
  ) as OperationalHealthHttp;
  assert.deepEqual(await http.readiness(scope, `Bearer ${token}`), {
    status: 200,
    body: ready,
  });
  assert.deepEqual(
    await http.readiness("another-workspace", `Bearer ${token}`),
    { status: 401, body: { error: "unauthorized" } },
  );
});
test("standalone controller liveness never runs readiness and readiness uses local scope", async () => {
  const calls: unknown[][] = [];
  const http = {
    readiness: async (...args: unknown[]) => {
      calls.push(args);
      return { status: 503, body: { error: "unavailable" } };
    },
  } as unknown as OperationalHealthHttp;
  const controller = new OperationalHealthController(http, {
    workspaceId: scope,
  } as StandaloneDatabase);
  let status = 0;
  let body: unknown;
  let headers: unknown;
  const response = {
    set(value: unknown) {
      headers = value;
      return this;
    },
    status(value: number) {
      status = value;
      return this;
    },
    json(value: unknown) {
      body = value;
    },
  };
  controller.live(response as unknown as Response);
  assert.equal(status, 200);
  assert.deepEqual(body, { live: true });
  assert.equal(calls.length, 0);
  await controller.ready(`Bearer ${token}`, response as unknown as Response);
  assert.deepEqual(calls, [[scope, `Bearer ${token}`]]);
  assert.equal(status, 503);
  assert.equal(
    (headers as Record<string, string>)["Cache-Control"],
    "no-store",
  );
});
test("standalone watchdog construction is inert and follows the actual scheduler lifecycle", async (context) => {
  const start = context.mock.method(
    DurableWorkScheduler.prototype,
    "start",
    () => {},
  );
  const stop = context.mock.method(
    DurableWorkScheduler.prototype,
    "stop",
    async () => {},
  );
  const watchStart = context.mock.method(
    WatchdogCoordinator.prototype,
    "start",
    () => {},
  );
  const watchStop = context.mock.method(
    WatchdogCoordinator.prototype,
    "stop",
    async () => {},
  );
  let connections = 0;
  const pool = {
    connect: async () => {
      connections++;
      throw new Error("unexpected connection");
    },
  } as unknown as Pool;
  const keys = SecretKeyRing.parse({
    version: 1,
    activeKeyId: "test",
    keys: { test: Buffer.alloc(32, 1).toString("base64") },
  });
  const { runtime } = standalonePagingRuntime(
    pool,
    scope,
    keys,
    "https://example.test",
    () => {},
    retentionFixture(),
    undefined,
    undefined,
    new HealthDeployment(configuration),
  );
  assert.equal(start.mock.callCount(), 0);
  assert.equal(watchStart.mock.callCount(), 0);
  const retentionStart = context.mock.method(
    RetentionCoordinator.prototype,
    "start",
    () => {},
  );
  const retentionStop = context.mock.method(
    RetentionCoordinator.prototype,
    "stop",
    async () => {},
  );
  runtime.onApplicationBootstrap();
  assert.equal(start.mock.callCount(), 1);
  assert.equal(watchStart.mock.callCount(), 1);
  await runtime.onModuleDestroy();
  assert.equal(stop.mock.callCount(), 1);
  assert.equal(watchStop.mock.callCount(), 1);
  assert.equal(retentionStart.mock.callCount(), 1);
  assert.equal(retentionStop.mock.callCount(), 1);
  assert.equal(connections, 0);
});

test("watchdog configuration requires a registered handler and fits the existing worker budget", async () => {
  const pool = {
    connect: async () => {
      throw new Error("unexpected connection");
    },
  } as unknown as Pool;
  const health = new HealthDeployment(configuration);
  assert.throws(
    () =>
      new PostgresJobsRuntime(
        pool,
        scope,
        { job: new Map(), outbox: new Map() },
        () => {},
        undefined,
        undefined,
        health,
      ),
    /requires its durable handler/,
  );
  const keys = SecretKeyRing.parse({
    version: 1,
    activeKeyId: "test",
    keys: { test: Buffer.alloc(32, 1).toString("base64") },
  });
  const destinations = { hosts: [], privateCidrs: [] };
  const probes = new ProbeDeployment({
    destinations,
    limits: { maxActive: 100, maxConfigured: 500, concurrency: 32 },
  });
  const metrics = new MetricDeployment({
    destinations,
    // Twelve reserved lanes include timeout, watch, cadence and rule evaluation and replay workers; 32 + 20 + 12 = 64.
    limits: { maxActive: 100, maxConfigured: 500, concurrency: 20 },
  });
  assert.throws(
    () =>
      standalonePagingRuntime(
        pool,
        scope,
        keys,
        "https://example.test",
        () => {},
        retentionFixture(),
        probes,
        new MetricDeployment({
          destinations,
          limits: { maxActive: 100, maxConfigured: 500, concurrency: 21 },
        }),
      ),
    /scheduler limit/,
  );
  const baseline = standalonePagingRuntime(
    pool,
    scope,
    keys,
    "https://example.test",
    () => {},
    retentionFixture(),
    probes,
    metrics,
  );
  await baseline.runtime.onModuleDestroy();
  const withWatchdog = standalonePagingRuntime(
    pool,
    scope,
    keys,
    "https://example.test",
    () => {},
    retentionFixture(),
    probes,
    new MetricDeployment({
      destinations,
      limits: { maxActive: 100, maxConfigured: 500, concurrency: 19 },
    }),
    health,
  );
  await withWatchdog.runtime.onModuleDestroy();
  assert.throws(
    () =>
      standalonePagingRuntime(
        pool,
        scope,
        keys,
        "https://example.test",
        () => {},
        retentionFixture(),
        probes,
        metrics,
        health,
      ),
    /scheduler limit/,
  );
});
