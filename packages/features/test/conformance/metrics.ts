import test, { type TestOptions } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  metricMonitorSchema,
  signalSourceSchema,
  workspaceIdSchema,
  type MetricMonitor,
} from "@bitsentry-escalator/features/contracts";
import {
  normalizeMetricCounts,
  metricPointAt,
  type MetricsRepository,
  type MetricsTransaction,
} from "@bitsentry-escalator/features/application";
import { seedSignalFixture } from "./signals.js";
export interface MetricsFixture {
  repository: MetricsRepository;
  dispose(): Promise<void>;
}
export async function seedMetricFixture(
  tx: MetricsTransaction,
): Promise<MetricMonitor> {
  await seedSignalFixture(tx);
  await tx.sources.insert(
    signalSourceSchema.parse({
      id: "metric-source",
      workspaceId: tx.workspaceId,
      serviceId: "service",
      environmentId: "production",
      name: "Requests",
      kind: "metrics",
      enabled: true,
      version: 1,
      grouping: "source-fingerprint",
      recovery: "explicit",
      recoveryHoldSeconds: 60,
      authSecretId: null,
      createdAt: tx.now,
      updatedAt: tx.now,
    }),
  );
  const monitor = metricMonitorSchema.parse({
    id: "metric",
    workspaceId: tx.workspaceId,
    sourceId: "metric-source",
    serviceId: "service",
    environmentId: "production",
    name: "Requests",
    enabled: true,
    version: 1,
    stepSeconds: 60,
    query: {
      connection: {
        provider: "prometheus",
        baseUrl: "https://metrics.example",
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
    createdAt: tx.now,
    updatedAt: tx.now,
  });
  assert.equal(await tx.metrics.put(monitor, null), true);
  return monitor;
}
export function metricFixtureObservation(
  tx: MetricsTransaction,
  monitor: MetricMonitor,
  id: string,
  point: string,
  errors = 10,
) {
  const matrix = (value: number) =>
    JSON.stringify({
      status: "success",
      data: {
        resultType: "matrix",
        result: [
          { metric: {}, values: [[Date.parse(point) / 1000, String(value)]] },
        ],
      },
    });
  const normalized = normalizeMetricCounts(
    monitor.query,
    { startAt: point, endAt: point, stepSeconds: monitor.stepSeconds },
    matrix(100),
    matrix(errors),
  );
  return {
    id,
    workspaceId: tx.workspaceId,
    monitorId: monitor.id,
    monitorVersion: monitor.version,
    observedAt: point,
    receivedAt: tx.now,
    reason: "sampled" as const,
    sample: normalized.samples[0],
    provenance: normalized.provenance,
  };
}
export function metricsConformance(
  name: string,
  create: () => Promise<MetricsFixture>,
  options: TestOptions & {
    register?: (name: string, run: () => Promise<void>) => void;
  } = {},
) {
  const register =
    options.register ??
    ((name: string, run: () => Promise<void>) => test(name, options, run));
  const check = (title: string, run: (f: MetricsFixture) => Promise<void>) =>
    register(`${name}: ${title}`, async () => {
      const f = await create();
      try {
        await run(f);
      } finally {
        await f.dispose();
      }
    });
  check(
    "configuration CAS retains immutable versions and trusted scope",
    async ({ repository }) => {
      const scope = workspaceIdSchema.parse(randomUUID());
      const monitor = await repository.transaction(scope, seedMetricFixture);
      await repository.transaction(scope, async (tx) => {
        await tx.metrics.lock(monitor.id);
        const updated = {
          ...monitor,
          name: "Changed",
          version: 2,
          updatedAt: tx.now,
        };
        assert.equal(await tx.metrics.put(updated, 1), true);
        assert.equal(await tx.metrics.put(updated, 1), false);
        assert.equal(
          (await tx.metrics.version(monitor.id, 1))?.name,
          "Requests",
        );
        assert.equal(
          (await tx.metrics.version(monitor.id, 2))?.name,
          "Changed",
        );
      });
      await repository.transaction(
        workspaceIdSchema.parse(randomUUID()),
        async (tx) => {
          assert.equal(await tx.metrics.get(monitor.id), undefined);
          assert.equal(await tx.metrics.version(monitor.id, 1), undefined);
        },
      );
    },
  );
  check(
    "recording derives a complete floor from scoped receipts and cannot fill missing counts",
    async ({ repository }) => {
      const scope = workspaceIdSchema.parse(randomUUID());
      await repository.transaction(scope, async (tx) => {
        const monitor = await seedMetricFixture(tx);
        const point = metricPointAt(tx.now, 60),
          before = new Date(Date.parse(point) - 60000).toISOString();
        const first = await tx.metrics.observe(
          metricFixtureObservation(tx, monitor, "before", before),
        );
        assert.equal(first.evaluation.state, "insufficient_data");
        const second = await tx.metrics.observe(
          metricFixtureObservation(tx, monitor, "now", point),
        );
        assert.equal(second.evaluation.state, "active");
        assert.deepEqual(second.inputIds, ["before", "now"]);
        assert.deepEqual(
          await tx.metrics.observe(
            metricFixtureObservation(tx, monitor, "now", point, 0),
          ),
          second,
        );
        const unknown = await tx.metrics.observe({
          ...metricFixtureObservation(tx, monitor, "0-unknown", point),
          reason: "provider_unavailable",
          sample: null,
          provenance: null,
        });
        assert.equal(unknown.evaluation.state, "insufficient_data");
      });
    },
  );
  check(
    "visibility uses receipt time, latest-point ties are deterministic, and history retains prior receipts",
    async ({ repository }) => {
      const scope = workspaceIdSchema.parse(randomUUID());
      await repository.transaction(scope, async (tx) => {
        const monitor = await seedMetricFixture(tx);
        const point = metricPointAt(tx.now, 60);
        await tx.metrics.observe(
          metricFixtureObservation(tx, monitor, "a", point),
        );
        await tx.metrics.observe(
          metricFixtureObservation(tx, monitor, "z", point, 0),
        );
        const query = {
          monitorId: monitor.id,
          monitorVersion: 1,
          startAt: point,
          endAt: point,
          visibleAt: tx.now,
          limit: 1,
        };
        assert.deepEqual(
          (await tx.metrics.window(query)).map((row) => row.id),
          ["z"],
        );
        assert.deepEqual(
          await tx.metrics.window({
            ...query,
            visibleAt: new Date(Date.parse(tx.now) - 1).toISOString(),
          }),
          [],
        );
        const first = await tx.metrics.history(monitor.id, { limit: 1 });
        assert.equal(first.items[0].id, "z");
        assert.equal(first.next, "z");
        const second = await tx.metrics.history(monitor.id, {
          limit: 1,
          after: first.next!,
        });
        assert.equal(second.items[0].id, "a");
        assert.equal(second.next, null);
      });
    },
  );
  check(
    "cross-scope writes poison the transaction and handles expire",
    async ({ repository }) => {
      const scope = workspaceIdSchema.parse(randomUUID());
      const monitor = await repository.transaction(scope, seedMetricFixture);
      let captured: MetricsTransaction | undefined;
      await assert.rejects(
        repository.transaction(scope, async (tx) => {
          captured = tx;
          await tx.metrics.lock(monitor.id);
          await tx.metrics.put(
            { ...monitor, version: 2, name: "rollback", updatedAt: tx.now },
            1,
          );
          try {
            await tx.metrics.put(
              {
                ...monitor,
                workspaceId: workspaceIdSchema.parse(randomUUID()),
                version: 3,
                updatedAt: tx.now,
              },
              2,
            );
          } catch {
            // Catching a scoped-operation error must still poison the transaction.
          }
        }),
        { code: "scope_violation" },
      );
      await repository.transaction(scope, async (tx) =>
        assert.equal((await tx.metrics.get(monitor.id))?.version, 1),
      );
      await assert.rejects(captured!.metrics.get(monitor.id), {
        code: "closed_transaction",
      });
    },
  );
  check(
    "observation, successor and audit roll back together; forged provenance is rejected",
    async ({ repository }) => {
      const scope = workspaceIdSchema.parse(randomUUID());
      const monitor = await repository.transaction(scope, seedMetricFixture);
      await assert.rejects(
        repository.transaction(scope, async (tx) => {
          await tx.metrics.lock(monitor.id);
          await tx.metrics.observe(
            metricFixtureObservation(
              tx,
              monitor,
              "rollback",
              metricPointAt(tx.now, 60),
            ),
          );
          await tx.work.enqueue("job", {
            id: "successor",
            kind: "metrics.poll",
            idempotencyKey: "successor",
            dueAt: tx.now,
            payload: {},
          });
          await tx.audit.append({
            id: "audit",
            workspaceId: scope,
            actor: { kind: "system", component: "metrics" },
            action: "metric.sampled",
            subjectType: "metric",
            subjectId: monitor.id,
            recordedAt: tx.now,
            metadata: {},
          });
          throw new Error("rollback");
        }),
        { message: "rollback" },
      );
      await repository.transaction(scope, async (tx) => {
        assert.equal(await tx.metrics.observation("rollback"), undefined);
        assert.equal((await tx.audit.list({ limit: 10 })).items.length, 0);
        assert.equal(
          await tx.work.enqueue("job", {
            id: "successor",
            kind: "metrics.poll",
            idempotencyKey: "successor",
            dueAt: tx.now,
            payload: {},
          }),
          "inserted",
        );
      });
      await assert.rejects(
        repository.transaction(scope, async (tx) => {
          await tx.metrics.lock(monitor.id);
          const input = metricFixtureObservation(
            tx,
            monitor,
            "forged",
            metricPointAt(tx.now, 60),
          );
          await tx.metrics.observe({
            ...input,
            provenance: {
              ...input.provenance,
              requestsQueryHash: "f".repeat(64),
            },
          });
        }),
        { code: "invalid_observation" },
      );
    },
  );
}
