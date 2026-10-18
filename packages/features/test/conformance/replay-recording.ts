import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  workspaceIdSchema,
  probeResultSchema,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import {
  probeJobId,
  type ProbeRepository,
  type MetricsRepository,
} from "@bitsentry-escalator/features/application";
import { seedProbeFixture } from "./probes.js";
import { seedMetricFixture } from "./metrics.js";
import { fixtureSignal } from "./signals.js";
export interface ReplayRecordingFixture {
  probes: ProbeRepository;
  metrics: MetricsRepository;
  /** Test-only SQL under the restricted role, with scoped session context and rollback on failure. */
  query(
    scope: WorkspaceId,
    sql: string,
    values?: unknown[],
  ): Promise<Record<string, unknown>[]>;
  upgrade(): Promise<void>;
  dispose(): Promise<void>;
}
const iso = (value: unknown) => {
  assert.equal(Object.prototype.toString.call(value), "[object Date]");
  return (value as Date).toISOString();
};
export function replayRecordingConformance(
  name: string,
  create: (recording: boolean) => Promise<ReplayRecordingFixture>,
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
    recording: boolean,
    run: (
      f: ReplayRecordingFixture,
      a: WorkspaceId,
      b: WorkspaceId,
    ) => Promise<void>,
  ) =>
    register(`${name}: ${title}`, async () => {
      const f = await create(recording);
      try {
        await run(
          f,
          workspaceIdSchema.parse(`replay_a_${randomUUID()}`),
          workspaceIdSchema.parse(`replay_b_${randomUUID()}`),
        );
      } finally {
        await f.dispose();
      }
    });
  scenario(
    "upgrade preserves old receipts and captures current configuration without backdating",
    false,
    async (f, a, b) => {
      let observed = "";
      await f.probes.transaction(a, async (tx) => {
        const probe = await seedProbeFixture(tx);
        observed = tx.now;
        await tx.probes.recordResult(
          probeResultSchema.parse({
            id: "old-receipt",
            workspaceId: a,
            probeId: probe.id,
            probeVersion: 1,
            observedAt: tx.now,
            outcome: "failed",
            reason: "timeout",
            statusCode: null,
            durationMs: 100,
          }),
        );
        await tx.sources.get("source");
        await tx.signals.insert(fixtureSignal(tx, "old-signal"));
        await tx.probes.lock(probe.id);
        assert.equal(
          await tx.probes.put({ ...probe, version: 2, updatedAt: tx.now }, 1),
          true,
        );
      });
      await f.metrics.transaction(b, async (tx) => {
        const metric = await seedMetricFixture(tx);
        await tx.metrics.lock(metric.id);
        assert.equal(
          await tx.metrics.put({ ...metric, version: 2, updatedAt: tx.now }, 1),
          true,
        );
      });
      await f.upgrade();
      const [receipt] = await f.query(
        a,
        "SELECT observed_at,received_at,scheduled_at,probe_version,data FROM escalator_probe_result WHERE id=$1",
        ["old-receipt"],
      );
      assert.equal(iso(receipt!.observed_at), observed);
      assert.equal(receipt!.received_at, null);
      assert.equal(receipt!.scheduled_at, null);
      assert.equal(receipt!.probe_version, null);
      assert.equal((receipt!.data as { probeVersion: number }).probeVersion, 1);
      const [signal] = await f.query(
        a,
        "SELECT source_version FROM escalator_signal_event WHERE id=$1",
        ["old-signal"],
      );
      assert.equal(signal!.source_version, null);
      const [probe] = await f.query(
        a,
        "SELECT version,effective_at,recorded_at,origin FROM escalator_probe_version",
      );
      assert.equal(Number(probe!.version), 2);
      assert.equal(probe!.origin, "capture");
      assert.ok(Date.parse(iso(probe!.effective_at)) >= Date.parse(observed));
      assert.equal(iso(probe!.effective_at), iso(probe!.recorded_at));
      const metrics = await f.query(
        b,
        "SELECT version,effective_at,recorded_at,origin FROM escalator_metric_version ORDER BY version",
      );
      assert.equal(metrics[0]!.effective_at, null);
      assert.equal(metrics[0]!.recorded_at, null);
      assert.equal(metrics[0]!.origin, null);
      assert.equal(metrics[1]!.origin, "capture");
      assert.equal(iso(metrics[1]!.effective_at), iso(metrics[1]!.recorded_at));
    },
  );
  scenario(
    "new writes retain their source revision, probe schedule and availability",
    true,
    async (f, a, b) => {
      let dueAt = "",
        runId = "";
      await f.probes.transaction(a, async (tx) => {
        const probe = await seedProbeFixture(tx);
        dueAt = tx.now;
        runId = probeJobId(a, probe.id, 1, dueAt);
        await tx.work.enqueue("job", {
          id: runId,
          kind: "probe.execute",
          idempotencyKey: runId,
          dueAt,
          payload: { probeId: probe.id, probeVersion: 1, dueAt, secretIds: [] },
        });
        const receipt = probeResultSchema.parse({
          id: runId,
          workspaceId: a,
          probeId: probe.id,
          probeVersion: 1,
          observedAt: tx.now,
          outcome: "failed",
          reason: "timeout",
          statusCode: null,
          durationMs: 100,
        });
        await tx.probes.recordResult(receipt);
        await tx.probes.recordResult({ ...receipt, id: "without-job" });
        const source = (await tx.sources.get("source"))!;
        await tx.signals.insert(fixtureSignal(tx, "first", "first-event"));
        assert.equal(
          await tx.sources.replace(
            { ...source, version: 2, name: "Changed", updatedAt: tx.now },
            1,
          ),
          true,
        );
        await tx.signals.insert(fixtureSignal(tx, "second", "second-event"));
      });
      await f.metrics.transaction(b, seedMetricFixture);
      const [receipt] = await f.query(
        a,
        "SELECT received_at,scheduled_at,probe_version FROM escalator_probe_result WHERE id=$1",
        [runId],
      );
      assert.equal(Number(receipt!.probe_version), 1);
      assert.equal(iso(receipt!.scheduled_at), dueAt);
      const [unmapped] = await f.query(
        a,
        "SELECT received_at,scheduled_at FROM escalator_probe_result WHERE id=$1",
        ["without-job"],
      );
      assert.equal(unmapped!.scheduled_at, null);
      assert.match(iso(unmapped!.received_at), /^\d{4}-/);
      assert.ok(Date.parse(iso(receipt!.received_at)) >= Date.parse(dueAt));
      const signals = await f.query(
        a,
        "SELECT id,source_version FROM escalator_signal_event ORDER BY id",
      );
      assert.deepEqual(
        signals.map((row) => [row.id, Number(row.source_version)]),
        [
          ["first", 1],
          ["second", 2],
        ],
      );
      const versions = await f.query(
        a,
        "SELECT version,origin,data FROM escalator_source_version WHERE source_id=$1 ORDER BY version",
        ["source"],
      );
      assert.deepEqual(
        versions.map((row) => [Number(row.version), row.origin]),
        [
          [1, "change"],
          [2, "change"],
        ],
      );
      assert.equal((versions[0]!.data as { name: string }).name, "Errors");
      const [metric] = await f.query(
        b,
        "SELECT effective_at,recorded_at,origin FROM escalator_metric_version",
      );
      assert.equal(metric!.origin, "change");
      assert.match(iso(metric!.recorded_at), /^\d{4}-/);
    },
  );
  scenario(
    "recording tables isolate tenants and reject payload edits without a revision",
    true,
    async (f, a, b) => {
      await f.probes.transaction(a, seedProbeFixture);
      await f.probes.transaction(b, seedProbeFixture);
      for (const table of [
        "escalator_source_version",
        "escalator_probe_version",
      ]) {
        const rows = await f.query(
          a,
          `SELECT __scope__ AS scope_id FROM ${table}`,
        );
        assert.ok(rows.length > 0);
        assert.ok(rows.every((row) => row.scope_id === a));
        assert.deepEqual(
          await f.query(
            workspaceIdSchema.parse("foreign"),
            `SELECT data FROM ${table}`,
          ),
          [],
        );
        await assert.rejects(f.query(a, `UPDATE ${table} SET data=data`), {
          code: "42501",
        });
      }
      await assert.rejects(
        f.query(
          a,
          "UPDATE escalator_signal_source SET data=jsonb_set(data,'{name}','\"Changed without revision\"') WHERE id=$1",
          ["source"],
        ),
        { code: "P0001" },
      );
      const rows = await f.query(
        a,
        "SELECT version,data FROM escalator_source_version WHERE source_id=$1",
        ["source"],
      );
      assert.equal(rows.length, 1);
      assert.equal((rows[0]!.data as { name: string }).name, "Errors");
    },
  );
}
