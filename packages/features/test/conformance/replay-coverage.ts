import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  workspaceIdSchema,
  responderIdSchema,
  probeResultSchema,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import {
  ReplayCoverageReader,
  probeJobId,
  metricPointAt,
  type ReplayCoverageRepository,
} from "@bitsentry-escalator/features/application";
import type { ReplayRecordingFixture } from "./replay-recording.js";
import { seedProbeFixture } from "./probes.js";
import { seedMetricFixture, metricFixtureObservation } from "./metrics.js";
import { fixtureSignal } from "./signals.js";
export interface CoverageFixture extends ReplayRecordingFixture {
  coverage: ReplayCoverageRepository;
}
export function replayCoverageConformance(
  name: string,
  create: (recording: boolean) => Promise<CoverageFixture>,
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
    run: (f: CoverageFixture, a: WorkspaceId, b: WorkspaceId) => Promise<void>,
  ) =>
    register(`${name}: ${title}`, async () => {
      const f = await create(true);
      try {
        await run(
          f,
          workspaceIdSchema.parse(`coverage_a_${randomUUID()}`),
          workspaceIdSchema.parse(`coverage_b_${randomUUID()}`),
        );
      } finally {
        await f.dispose();
      }
    });
  const now = async (f: CoverageFixture, scope: WorkspaceId) => {
    const [row] = await f.query(
      scope,
      // Advance beyond a preceding receipt after millisecond normalization, on the disposable DB only.
      "SELECT date_trunc('milliseconds',clock_timestamp()) AS now FROM pg_sleep(0.002)",
    );
    return (row!.now as Date).toISOString();
  };
  scenario(
    "bounded metadata preserves probe timing and populated tenant isolation",
    async (f, a, b) => {
      for (const scope of [a, b])
        await f.probes.transaction(scope, async (tx) => {
          const probe = await seedProbeFixture(tx);
          const dueAt = tx.now;
          const id = probeJobId(scope, probe.id, 1, dueAt);
          await tx.work.enqueue("job", {
            id,
            kind: "probe.execute",
            idempotencyKey: id,
            dueAt,
            payload: {
              probeId: probe.id,
              probeVersion: 1,
              dueAt,
              secretIds: [],
            },
          });
          await tx.probes.recordResult(
            probeResultSchema.parse({
              id,
              workspaceId: scope,
              probeId: probe.id,
              probeVersion: 1,
              observedAt: tx.now,
              outcome: scope === a ? "healthy" : "unknown",
              reason: scope === a ? "assertions_passed" : "secret_unavailable",
              statusCode: scope === a ? 200 : null,
              durationMs: 1,
            }),
          );
        });
      // Each tenant's seed time differs; use the retained configuration anchor for the requested scope.
      const [config] = await f.query(
        a,
        "SELECT data->>'updatedAt' AS anchor FROM escalator_probe_version WHERE probe_id='probe'",
      );
      const startAt = String(config!.anchor);
      const visibleAt = await now(f, a);
      const endAt = visibleAt;
      assert.ok(Date.parse(endAt) > Date.parse(startAt));
      const raw = await f.coverage.snapshot(a, {
        kind: "probe",
        id: "probe",
        startAt,
        endAt,
        visibleAt,
      });
      assert.equal(raw.receipts.length, 1);
      assert.equal(raw.receipts[0]!.usable, true);
      assert.equal(raw.receipts[0]!.slotAt, startAt);
      assert.equal(raw.configurations[0]!.anchorAt, startAt);
      assert.ok(raw.receipts[0]!.receivedAt);
      assert.equal(JSON.stringify(raw).includes("example.test"), false);
      const reader = new ReplayCoverageReader(f.coverage);
      const actor = {
        workspaceId: a,
        responderId: responderIdSchema.parse("reader"),
        role: "viewer" as const,
      };
      const report = await reader.read(actor, {
        kind: "probe",
        id: "probe",
        startAt,
        endAt,
        visibleAt,
      });
      assert.ok("availableSlots" in report.report);
      assert.equal(report.report.availableSlots, 1);
      await assert.rejects(
        f.coverage.snapshot(workspaceIdSchema.parse("unknown"), {
          kind: "probe",
          id: "probe",
          startAt,
          endAt,
          visibleAt,
        }),
      );
    },
  );
  scenario(
    "metric projection retains quality and omits query payloads and input lists",
    async (f, a) => {
      let startAt = "";
      await f.metrics.transaction(a, async (tx) => {
        const old = new Date(Date.parse(tx.now) - 120000).toISOString();
        const metric = await seedMetricFixture(tx);
        startAt = metricPointAt(
          new Date(Date.parse(old) + 60000).toISOString(),
          60,
        );
        await tx.metrics.observe(
          metricFixtureObservation(tx, metric, "metric-receipt", startAt),
        );
      });
      const visibleAt = await now(f, a),
        endAt = visibleAt;
      const data = await f.coverage.snapshot(a, {
        kind: "metric",
        id: "metric",
        startAt,
        endAt,
        visibleAt,
      });
      assert.equal(data.receipts.length, 1);
      assert.equal(data.receipts[0]!.usable, true);
      assert.equal(
        data.configurations[0]!.anchorAt,
        "1970-01-01T00:00:00.000Z",
      );
      assert.equal(JSON.stringify(data).includes("inputIds"), false);
      assert.equal(JSON.stringify(data).includes("requestsQuery"), false);
    },
  );
  scenario(
    "event-driven coverage keeps source silence distinct from periodic monitoring",
    async (f, a) => {
      let startAt = "";
      await f.probes.transaction(a, async (tx) => {
        const old = new Date(Date.parse(tx.now) - 120000).toISOString();
        await seedProbeFixture(tx);
        startAt = old;
        await tx.sources.get("source");
        await tx.signals.insert({
          ...fixtureSignal(tx, "signal"),
          observedAt: old,
        });
      });
      const endAt = new Date(Date.parse(startAt) + 60000).toISOString(),
        visibleAt = await now(f, a);
      const result = await new ReplayCoverageReader(f.coverage).read(
        {
          workspaceId: a,
          responderId: responderIdSchema.parse("reader"),
          role: "viewer",
        },
        { kind: "signal", id: "source", startAt, endAt, visibleAt },
      );
      assert.ok("continuity" in result.report);
      assert.equal(result.report.continuity, "not_inferred");
      assert.equal(result.report.visibleCount, 1);
    },
  );
}
