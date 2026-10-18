import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  workspaceIdSchema,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import {
  pruneReplayInTransaction,
  probeJobId,
  metricJobId,
  metricPointAt,
  type ProbeRepository,
  type MetricsRepository,
  type DetectionRepository,
  type ReplayPruneRepository,
} from "@bitsentry-escalator/features/application";
import { seedSignalFixture, fixtureSignal } from "./signals.js";
import { seedProbeFixture } from "./probes.js";
import { seedMetricFixture, metricFixtureObservation } from "./metrics.js";
import { detectionRows } from "./detection.js";
export interface RetentionPruningFixture {
  detection: DetectionRepository;
  probes: ProbeRepository;
  metrics: MetricsRepository;
  pruning: ReplayPruneRepository;
  query(
    scope: WorkspaceId,
    sql: string,
    values?: unknown[],
  ): Promise<Record<string, unknown>[]>;
  dispose(): Promise<void>;
}
export function retentionPruningConformance(
  name: string,
  create: () => Promise<RetentionPruningFixture>,
  options: {
    skip?: string;
    register?: (name: string, run: () => Promise<void>) => unknown;
  } = {},
) {
  const register =
    options.register ??
    ((title, run) => test(title, { skip: options.skip }, run));
  const scenario = (
    title: string,
    run: (
      f: RetentionPruningFixture,
      a: WorkspaceId,
      b: WorkspaceId,
    ) => Promise<void>,
  ) =>
    register(`${name}: ${title}`, async () => {
      const f = await create();
      try {
        await run(
          f,
          workspaceIdSchema.parse(`prune_a_${randomUUID()}`),
          workspaceIdSchema.parse(`prune_b_${randomUUID()}`),
        );
      } finally {
        await f.dispose();
      }
    });
  const usage = async (f: RetentionPruningFixture, scope: WorkspaceId) => {
    const [row] = await f.query(
      scope,
      "SELECT payload_bytes FROM escalator_replay_usage WHERE __scope__=$1",
      [scope],
    );
    return Number(row!.payload_bytes);
  };
  const seed = async (
    f: RetentionPruningFixture,
    scope: WorkspaceId,
    ids: string[],
  ) => {
    await f.detection.transaction(scope, async (tx) => {
      await seedSignalFixture(tx);
      for (const id of ids) {
        await tx.signals.insert({
          ...fixtureSignal(tx, id, id),
          observedAt: new Date(
            Date.parse(tx.now) - 31 * 86400000,
          ).toISOString(),
        });
        await tx.detection.recordProcessed({
          id,
          workspaceId: scope,
          sourceId: "source",
          incidentId: null,
          disposition: "stale",
          recordedAt: tx.now,
        });
        await tx.work.enqueue("job", {
          id: `signal.process:${id}`,
          kind: "signal.process",
          idempotencyKey: id,
          payload: { signalId: id },
          dueAt: tx.now,
        });
      }
    });
    await f.query(
      scope,
      "UPDATE escalator_job SET state='completed',completed_at=transaction_timestamp() WHERE __scope__=$1 AND id=ANY($2::text[])",
      [scope, ids.map((id) => `signal.process:${id}`)],
    );
  };
  const prune = (
    f: RetentionPruningFixture,
    scope: WorkspaceId,
    auditId: string = randomUUID(),
  ) =>
    f.pruning.transaction(scope, "source", (tx) =>
      pruneReplayInTransaction(tx, "source", null, auditId),
    );
  scenario(
    "only completed processed unreferenced receipts are removed; tombstones prevent replay",
    async (f, a, b) => {
      const ids = [
        "eligible",
        "event",
        "pending",
        "running",
        "failed",
        "cancelled",
        "malformed",
        "missing",
        "unprocessed",
      ];
      await seed(f, a, ids);
      await seed(f, b, ["eligible"]);
      const other = await usage(f, b);
      for (const state of ["pending", "failed", "cancelled"])
        await f.query(
          a,
          "UPDATE escalator_job SET state=$2,completed_at=NULL WHERE __scope__=$1 AND id=$3",
          [a, state, `signal.process:${state}`],
        );
      await f.query(
        a,
        "UPDATE escalator_job SET state='running',completed_at=NULL,lease_token='owner',lease_expires_at=transaction_timestamp()+interval '1 hour' WHERE __scope__=$1 AND id='signal.process:running'",
        [a],
      );
      await f.query(
        a,
        "UPDATE escalator_job SET payload='{}'::jsonb WHERE __scope__=$1 AND id='signal.process:malformed'",
        [a],
      );
      await f.query(
        a,
        "DELETE FROM escalator_job WHERE __scope__=$1 AND id='signal.process:missing'",
        [a],
      );
      await f.query(
        a,
        "DELETE FROM escalator_detection_processed WHERE __scope__=$1 AND id='unprocessed'",
        [a],
      );
      await f.detection.transaction(a, async (tx) => {
        const { alert, group } = await detectionRows(tx);
        await tx.detection.lockGroup(group.id);
        await tx.detection.putGroup(group, null);
        await tx.detection.putAlert(alert);
      });
      const before = await usage(f, a);
      const result = await prune(f, a);
      assert.equal(result.deletedRows, 1);
      assert.ok(result.deletedBytes > 0);
      assert.equal(result.retainedBytes, before - result.deletedBytes);
      assert.equal(await usage(f, a), result.retainedBytes);
      assert.equal(await usage(f, b), other);
      const rows = await f.query(
        a,
        'SELECT id FROM escalator_signal_event ORDER BY id COLLATE "C"',
      );
      assert.deepEqual(
        rows.map((row) => row.id),
        ids.filter((id) => id !== "eligible").sort(),
      );
      for (const table of [
        "escalator_signal_event",
        "escalator_detection_processed",
        "escalator_job",
      ])
        assert.deepEqual(
          await f.query(
            a,
            `SELECT id FROM ${table} WHERE __scope__=$1 AND id=$2`,
            [
              a,
              table === "escalator_job"
                ? "signal.process:eligible"
                : "eligible",
            ],
          ),
          [],
        );
      assert.equal(
        (
          await f.query(
            a,
            "SELECT signal_id FROM escalator_signal_tombstone WHERE __scope__=$1",
            [a],
          )
        ).length,
        1,
      );
      await f.detection.transaction(a, async (tx) => {
        assert.equal(
          await tx.signals.insert(fixtureSignal(tx, "eligible", "eligible")),
          "duplicate",
        );
        assert.equal((await tx.audit.list({ limit: 100 })).items.length, 1);
      });
      assert.equal(await usage(f, a), result.retainedBytes);
      assert.equal((await prune(f, a)).deletedRows, 0);
      assert.deepEqual(
        await f.query(
          b,
          "SELECT signal_id FROM escalator_signal_tombstone WHERE __scope__=$1",
          [a],
        ),
        [],
      );
      await assert.rejects(f.pruning.transaction(a, "absent", async () => {}));
    },
  );
  scenario(
    "audit failure rolls back receipts, dependencies, tombstones and accounting",
    async (f, a) => {
      await seed(f, a, ["eligible"]);
      await f.detection.transaction(a, (tx) =>
        tx.audit.append({
          id: "collision",
          workspaceId: a,
          actor: { kind: "system", component: "test" },
          action: "test",
          subjectType: "signal_source",
          subjectId: "source",
          recordedAt: tx.now,
          metadata: {},
        }),
      );
      const before = await usage(f, a);
      await assert.rejects(prune(f, a, "collision"));
      assert.equal(await usage(f, a), before);
      for (const table of [
        "escalator_signal_event",
        "escalator_detection_processed",
        "escalator_job",
      ])
        assert.equal(
          (await f.query(a, `SELECT id FROM ${table} WHERE __scope__=$1`, [a]))
            .length,
          1,
        );
      assert.deepEqual(
        await f.query(a, "SELECT signal_id FROM escalator_signal_tombstone"),
        [],
      );
      assert.equal((await prune(f, a)).deletedRows, 1);
    },
  );
  scenario(
    "bounded deletion resumes without skipping eligible rows",
    async (f, a) => {
      await seed(
        f,
        a,
        Array.from(
          { length: 105 },
          (_, i) => `event-${String(i).padStart(3, "0")}`,
        ),
      );
      const first = await prune(f, a);
      assert.equal(first.deletedRows, 100);
      assert.equal(first.complete, false);
      assert.ok(first.next);
      const second = await f.pruning.transaction(a, "source", (tx) =>
        pruneReplayInTransaction(tx, "source", first.next, randomUUID()),
      );
      assert.equal(second.deletedRows, 5);
      assert.equal(second.complete, true);
      assert.equal(second.retainedBytes, 0);
      assert.equal(await usage(f, a), 0);
    },
  );
  scenario(
    "concurrent sweeps serialize without duplicate accounting or audits",
    async (f, a) => {
      await seed(f, a, ["eligible"]);
      const results = await Promise.all([prune(f, a), prune(f, a)]);
      assert.equal(
        results.reduce((sum, result) => sum + result.deletedRows, 0),
        1,
      );
      assert.equal(await usage(f, a), 0);
      await f.detection.transaction(a, async (tx) =>
        assert.equal((await tx.audit.list({ limit: 100 })).items.length, 1),
      );
    },
  );
  scenario(
    "probe current state and metric live windows remain protected",
    async (f, a, b) => {
      const probeIds: string[] = [];
      await f.probes.transaction(a, async (tx) => {
        const probe = await seedProbeFixture(tx);
        for (let i = 0; i < 2; i++) {
          const dueAt = new Date(
            Date.parse(tx.now) - (2 - i) * 60000,
          ).toISOString();
          const id = probeJobId(a, probe.id, 1, dueAt);
          probeIds.push(id);
          await tx.work.enqueue("job", {
            id,
            kind: "probe.execute",
            idempotencyKey: id,
            payload: {
              probeId: probe.id,
              probeVersion: 1,
              dueAt,
              secretIds: [],
            },
            dueAt,
          });
          await tx.probes.recordResult({
            id,
            workspaceId: a,
            probeId: probe.id,
            probeVersion: 1,
            observedAt: tx.now,
            outcome: "healthy",
            reason: "assertions_passed",
            statusCode: 200,
            durationMs: 10,
          });
        }
        await tx.probes.putState({
          workspaceId: a,
          probeId: probe.id,
          probeVersion: 1,
          lastResultId: probeIds[1]!,
          lastObservedAt: tx.now,
          active: false,
          consecutiveFailures: 0,
          consecutiveSuccesses: 1,
        });
      });
      const metricIds: string[] = [];
      await f.metrics.transaction(b, async (tx) => {
        const monitor = await seedMetricFixture(tx);
        for (const offset of [3600000, 0]) {
          const dueAt = metricPointAt(
            new Date(Date.parse(tx.now) - offset).toISOString(),
            60,
          );
          const id = metricJobId(b, monitor.id, 1, dueAt);
          metricIds.push(id);
          await tx.work.enqueue("job", {
            id,
            kind: "metrics.poll",
            idempotencyKey: id,
            payload: {
              monitorId: monitor.id,
              monitorVersion: 1,
              dueAt,
              secretIds: [],
            },
            dueAt,
          });
          const observation = metricFixtureObservation(tx, monitor, id, dueAt);
          await tx.metrics.observe(
            offset
              ? {
                  ...observation,
                  reason: "stale_window",
                  sample: null,
                  provenance: null,
                }
              : observation,
          );
        }
      });
      for (const [scope, ids] of [
        [a, probeIds],
        [b, metricIds],
      ] as const)
        await f.query(
          scope,
          "UPDATE escalator_job SET state='completed',completed_at=transaction_timestamp() WHERE __scope__=$1 AND id=ANY($2::text[])",
          [scope, ids],
        );
      for (const [scope, source, ids] of [
        [a, "probe-source", probeIds],
        [b, "metric-source", metricIds],
      ] as const) {
        const before = await usage(f, scope);
        await f.pruning.transaction(scope, source, async (tx) => {
          const snapshot = await tx.retentionPrune.snapshot(null);
          assert.equal(
            snapshot.candidates.find((row) => row.id === ids[0])?.protected,
            false,
          );
          assert.equal(
            snapshot.candidates.find((row) => row.id === ids[1])?.protected,
            true,
          );
          const chosen = snapshot.candidates.filter((row) => row.id === ids[0]);
          const result = await tx.retentionPrune.remove(chosen);
          assert.equal(result.deletedRows, 1);
          assert.equal(result.retainedBytes, before - chosen[0]!.bytes);
        });
        await f.pruning.transaction(scope, source, async (tx) => {
          const remaining = await tx.retentionPrune.snapshot(null);
          // Compare plain string copies: driver rows may come from another realm.
          assert.deepEqual(
            Array.from(remaining.candidates, (row) => String(row.id)),
            [String(ids[1])],
          );
        });
      }
    },
  );
}
