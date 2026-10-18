import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  workspaceIdSchema,
  responderIdSchema,
  workspaceSchema,
  probeResultSchema,
  defaultReplayRetention,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import {
  RetentionPolicyManagement,
  metricPointAt,
  type RetentionPolicyRepository,
} from "@bitsentry-escalator/features/application";
import type { ReplayRecordingFixture } from "./replay-recording.js";
import { seedProbeFixture } from "./probes.js";
import { seedMetricFixture, metricFixtureObservation } from "./metrics.js";
import { fixtureSignal } from "./signals.js";
export interface RetentionAccountingFixture extends ReplayRecordingFixture {
  policies: RetentionPolicyRepository;
}
export function retentionAccountingConformance(
  name: string,
  create: (accounting: boolean) => Promise<RetentionAccountingFixture>,
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
    accounting: boolean,
    run: (
      f: RetentionAccountingFixture,
      a: WorkspaceId,
      b: WorkspaceId,
    ) => Promise<void>,
  ) =>
    register(`${name}: ${title}`, async () => {
      const f = await create(accounting);
      try {
        await run(
          f,
          workspaceIdSchema.parse(`retention_a_${randomUUID()}`),
          workspaceIdSchema.parse(`retention_b_${randomUUID()}`),
        );
      } finally {
        await f.dispose();
      }
    });
  const usage = async (f: RetentionAccountingFixture, scope: WorkspaceId) => {
    const [row] = await f.query(
      scope,
      "SELECT payload_bytes FROM escalator_replay_usage WHERE __scope__=$1",
      [scope],
    );
    return BigInt(String(row!.payload_bytes));
  };
  scenario(
    "policy compare-and-swap is scoped, audited and atomic",
    true,
    async (f, a, b) => {
      for (const scope of [a, b])
        await f.policies.transaction(scope, async (tx) =>
          tx.workspace.insert(
            workspaceSchema.parse({
              id: scope,
              name: "Team",
              createdAt: tx.now,
              updatedAt: tx.now,
            }),
          ),
        );
      assert.equal(await usage(f, a), 0n);
      assert.equal(await usage(f, b), 0n);
      const actor = {
        workspaceId: a,
        responderId: responderIdSchema.parse("admin"),
        role: "administrator" as const,
      };
      const management = new RetentionPolicyManagement(
        f.policies,
        () => "policy-audit",
      );
      assert.equal((await management.get(actor)).configured, null);
      const outcomes = await Promise.allSettled([
        management.save(actor, {
          ...defaultReplayRetention,
          days: 10,
          expectedVersion: null,
        }),
        management.save(actor, {
          ...defaultReplayRetention,
          days: 20,
          expectedVersion: null,
        }),
      ]);
      assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
      const before = (await management.get(actor)).configured!;
      assert.equal(before.version, 1);
      await assert.rejects(
        management.save(actor, {
          ...defaultReplayRetention,
          days: 2,
          expectedVersion: 1,
        }),
      );
      assert.deepEqual((await management.get(actor)).configured, before);
      assert.equal(
        (await management.get({ ...actor, workspaceId: b })).configured,
        null,
      );
      await f.policies.transaction(a, async (tx) =>
        assert.equal((await tx.audit.list({ limit: 100 })).items.length, 1),
      );
      assert.deepEqual(
        await f.query(
          b,
          "SELECT version FROM escalator_retention_policy WHERE __scope__=$1",
          [a],
        ),
        [],
      );
    },
  );
  scenario(
    "upgrade, duplicate receipts, rollback, deletion and tombstones preserve scoped byte totals",
    false,
    async (f, a, b) => {
      await f.probes.transaction(a, async (tx) => {
        const probe = await seedProbeFixture(tx);
        await tx.probes.recordResult(
          probeResultSchema.parse({
            id: "probe-receipt",
            workspaceId: a,
            probeId: probe.id,
            probeVersion: 1,
            observedAt: tx.now,
            outcome: "failed",
            reason: "timeout",
            statusCode: null,
            durationMs: 10,
          }),
        );
        await tx.signals.insert(fixtureSignal(tx, "first"));
      });
      await f.metrics.transaction(b, async (tx) => {
        const metric = await seedMetricFixture(tx);
        await tx.metrics.observe(
          metricFixtureObservation(
            tx,
            metric,
            "metric-receipt",
            metricPointAt(tx.now, 60),
          ),
        );
      });
      await f.upgrade();
      for (const scope of [a, b]) {
        const [sum] = await f.query(
          scope,
          "SELECT COALESCE(sum(payload_bytes),0) AS bytes FROM (SELECT payload_bytes FROM escalator_signal_event UNION ALL SELECT payload_bytes FROM escalator_probe_result UNION ALL SELECT payload_bytes FROM escalator_metric_observation) r",
        );
        assert.equal(await usage(f, scope), BigInt(String(sum!.bytes)));
        assert.ok((await usage(f, scope)) > 0n);
      }
      const initial = await usage(f, a),
        other = await usage(f, b);
      await f.probes.transaction(a, async (tx) =>
        assert.equal(
          await tx.signals.insert(fixtureSignal(tx, "first")),
          "duplicate",
        ),
      );
      assert.equal(await usage(f, a), initial);
      await assert.rejects(
        f.probes.transaction(a, async (tx) => {
          await tx.signals.insert(fixtureSignal(tx, "rollback"));
          throw new Error("rollback fixture");
        }),
        /rollback fixture/,
      );
      assert.equal(await usage(f, a), initial);
      assert.deepEqual(
        await f.query(
          a,
          "SELECT id FROM escalator_signal_event WHERE id='rollback'",
        ),
        [],
      );
      await f.probes.transaction(a, async (tx) =>
        assert.equal(
          await tx.signals.insert(fixtureSignal(tx, "next")),
          "inserted",
        ),
      );
      const [added] = await f.query(
        a,
        "SELECT payload_bytes FROM escalator_signal_event WHERE id='next'",
      );
      assert.equal(
        await usage(f, a),
        initial + BigInt(String(added!.payload_bytes)),
      );
      // Fixture-only DELETE exercises trigger arithmetic, not the future pruning eligibility contract.
      const [removed] = await f.query(
        a,
        "SELECT payload_bytes FROM escalator_signal_event WHERE id='first'",
      );
      await f.query(
        a,
        "INSERT INTO escalator_signal_tombstone(__scope__,signal_id,source_id,retained_at) VALUES($1,'first','source',clock_timestamp())",
        [a],
      );
      await f.query(a, "DELETE FROM escalator_signal_event WHERE id='first'");
      const after =
        initial +
        BigInt(String(added!.payload_bytes)) -
        BigInt(String(removed!.payload_bytes));
      assert.equal(await usage(f, a), after);
      await f.probes.transaction(a, async (tx) =>
        assert.equal(
          await tx.signals.insert(fixtureSignal(tx, "first")),
          "duplicate",
        ),
      );
      assert.equal(await usage(f, a), after);
      assert.deepEqual(
        await f.query(
          a,
          "SELECT id FROM escalator_signal_event WHERE id='first'",
        ),
        [],
      );
      await assert.rejects(
        f.query(
          a,
          "UPDATE escalator_replay_usage SET payload_bytes=-1 WHERE __scope__=$1",
          [a],
        ),
        { code: "23514" },
      );
      assert.equal(await usage(f, a), after);
      assert.deepEqual(
        await f.query(
          a,
          "UPDATE escalator_replay_usage SET payload_bytes=0 WHERE __scope__=$1 RETURNING payload_bytes",
          [b],
        ),
        [],
      );
      assert.equal(await usage(f, b), other);
    },
  );
}
