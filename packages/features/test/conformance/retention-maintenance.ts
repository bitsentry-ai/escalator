import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  workspaceIdSchema,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import {
  initializeRetentionMaintenance,
  RetentionMaintenanceJobs,
  retentionMaintenanceKind,
  type RetentionMaintenanceRepository,
  type DurableWorkStore,
} from "@bitsentry-escalator/features/application";
import type { RetentionPruningFixture } from "./retention-pruning.js";
import { seedSignalFixture, fixtureSignal } from "./signals.js";
export interface RetentionMaintenanceFixture extends RetentionPruningFixture {
  maintenance: RetentionMaintenanceRepository;
  work: DurableWorkStore;
}
export function retentionMaintenanceConformance(
  name: string,
  create: () => Promise<RetentionMaintenanceFixture>,
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
      f: RetentionMaintenanceFixture,
      a: WorkspaceId,
      b: WorkspaceId,
    ) => Promise<void>,
  ) =>
    register(`${name}: ${title}`, async () => {
      const f = await create();
      try {
        await run(
          f,
          workspaceIdSchema.parse(`maint_a_${randomUUID()}`),
          workspaceIdSchema.parse(`maint_b_${randomUUID()}`),
        );
      } finally {
        await f.dispose();
      }
    });
  const seed = async (
    f: RetentionMaintenanceFixture,
    scope: WorkspaceId,
    count = 0,
  ) => {
    await f.detection.transaction(scope, seedSignalFixture);
    for (let start = 0; start < count; start += 20)
      await f.detection.transaction(scope, async (tx) => {
        for (let i = start; i < Math.min(count, start + 20); i++) {
          const id = `event-${String(i).padStart(3, "0")}`;
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
    const ids = Array.from(
      { length: count },
      (_, i) => `signal.process:event-${String(i).padStart(3, "0")}`,
    );
    await f.query(
      scope,
      "UPDATE escalator_job SET state='completed',completed_at=transaction_timestamp() WHERE __scope__=$1 AND id=ANY($2::text[])",
      [scope, ids],
    );
  };
  const usage = async (f: RetentionMaintenanceFixture, scope: WorkspaceId) =>
    Number(
      (
        await f.query(
          scope,
          "SELECT payload_bytes FROM escalator_replay_usage WHERE __scope__=$1",
          [scope],
        )
      )[0]!.payload_bytes,
    );
  const claim = async (f: RetentionMaintenanceFixture, scope: WorkspaceId) => {
    const state = (await f.maintenance.read(scope))!;
    // Test-only deadline advancement; no sleeps and no alteration of the authoritative payload.
    await f.query(
      scope,
      "UPDATE escalator_job SET due_at=transaction_timestamp() WHERE __scope__=$1 AND id=$2 AND kind='retention.sweep' AND state='pending'",
      [scope, state.jobId],
    );
    const lease = await f.work.claim({
      workspaceId: scope,
      queue: "job",
      token: randomUUID(),
      leaseMs: 30000,
      kinds: [retentionMaintenanceKind],
    });
    assert.ok(lease);
    return lease;
  };
  const step = async (f: RetentionMaintenanceFixture, scope: WorkspaceId) => {
    const lease = await claim(f, scope);
    assert.deepEqual(
      await new RetentionMaintenanceJobs(f.maintenance).run(
        lease,
        new AbortController().signal,
      ),
      { state: "completed" },
    );
    assert.equal(await f.work.settle(lease, { state: "completed" }), true);
  };
  scenario(
    "concurrent initialization creates one scoped intent and foreign keys protect its identity",
    async (f, a, b) => {
      await seed(f, a);
      await seed(f, b);
      await Promise.all([
        initializeRetentionMaintenance(f.maintenance, a),
        initializeRetentionMaintenance(f.maintenance, a),
      ]);
      await initializeRetentionMaintenance(f.maintenance, b);
      assert.equal(
        (
          await f.query(
            a,
            "SELECT id FROM escalator_job WHERE kind='retention.sweep'",
          )
        ).length,
        1,
      );
      assert.deepEqual(
        await f.query(
          b,
          "SELECT * FROM escalator_retention_schedule WHERE __scope__=$1",
          [a],
        ),
        [],
      );
      await f.detection.transaction(b, async (tx) => {
        const source = (await tx.sources.get("source"))!;
        await tx.sources.insert({
          ...source,
          id: "foreign-source",
          createdAt: tx.now,
          updatedAt: tx.now,
        });
      });
      await step(f, a);
      const before = (await f.maintenance.read(a))!;
      const other = (await f.maintenance.read(b))!;
      await assert.rejects(
        f.query(a, "DELETE FROM escalator_job WHERE __scope__=$1 AND id=$2", [
          a,
          before.jobId,
        ]),
      );
      await assert.rejects(
        f.query(
          a,
          "UPDATE escalator_retention_schedule SET current_job_id=$2 WHERE __scope__=$1",
          [a, other.jobId],
        ),
      );
      await assert.rejects(
        f.maintenance.transaction(a, "foreign-source", async () => {
          assert.fail("Foreign source hint reached pruning transaction");
        }),
      );
      assert.deepEqual(await f.maintenance.read(a), before);
      await initializeRetentionMaintenance(f.maintenance, a);
      assert.deepEqual(await f.maintenance.read(a), before);
    },
  );
  scenario(
    "bounded deletion and cursor commit together; crash retries do not prune twice",
    async (f, a, b) => {
      await seed(f, a, 105);
      await seed(f, b, 1);
      const otherBytes = await usage(f, b);
      await initializeRetentionMaintenance(f.maintenance, a);
      await step(f, a);
      const lease = await claim(f, a),
        jobs = new RetentionMaintenanceJobs(f.maintenance);
      assert.deepEqual(await jobs.run(lease, new AbortController().signal), {
        state: "completed",
      });
      const committed = (await f.maintenance.read(a))!;
      assert.equal(committed.sourceId, "source");
      assert.ok(committed.after);
      assert.equal(
        (await f.query(a, "SELECT id FROM escalator_signal_event")).length,
        5,
      );
      assert.deepEqual(await jobs.run(lease, new AbortController().signal), {
        state: "completed",
      });
      assert.deepEqual(await f.maintenance.read(a), committed);
      assert.equal(
        (await f.query(a, "SELECT id FROM escalator_signal_event")).length,
        5,
      );
      assert.equal(await f.work.settle(lease, { state: "completed" }), true);
      await step(f, a);
      const completed = (await f.maintenance.read(a))!;
      assert.equal(completed.sourceId, null);
      assert.equal(completed.after, null);
      assert.ok(completed.completedAt);
      assert.equal(await usage(f, a), 0);
      assert.equal(await usage(f, b), otherBytes);
      assert.equal(
        (await f.query(a, "SELECT signal_id FROM escalator_signal_tombstone"))
          .length,
        105,
      );
      assert.deepEqual(
        await f.query(a, "SELECT id FROM escalator_detection_processed"),
        [],
      );
      assert.deepEqual(
        await f.query(
          a,
          "SELECT id FROM escalator_job WHERE kind='signal.process'",
        ),
        [],
      );
      await f.detection.transaction(a, async (tx) =>
        assert.equal(
          (await tx.audit.list({ limit: 100 })).items.filter(
            (row) => row.action === "retention.payloads.pruned",
          ).length,
          2,
        ),
      );
    },
  );
  scenario(
    "audit failure rolls back the successor, schedule, payloads and counters",
    async (f, a) => {
      await seed(f, a, 1);
      await initializeRetentionMaintenance(f.maintenance, a);
      await step(f, a);
      const lease = await claim(f, a),
        before = (await f.maintenance.read(a))!,
        bytes = await usage(f, a);
      await f.detection.transaction(a, (tx) =>
        tx.audit.append({
          id: `retention-audit:${before.jobId}`,
          workspaceId: a,
          actor: { kind: "system", component: "test" },
          action: "test",
          subjectType: "retention",
          subjectId: "schedule",
          recordedAt: tx.now,
          metadata: {},
        }),
      );
      await assert.rejects(
        new RetentionMaintenanceJobs(f.maintenance).run(
          lease,
          new AbortController().signal,
        ),
      );
      assert.deepEqual(await f.maintenance.read(a), before);
      assert.equal(await usage(f, a), bytes);
      assert.equal(
        (await f.query(a, "SELECT id FROM escalator_signal_event")).length,
        1,
      );
      assert.equal(
        (await f.query(a, "SELECT id FROM escalator_detection_processed"))
          .length,
        1,
      );
      assert.deepEqual(
        await f.query(a, "SELECT signal_id FROM escalator_signal_tombstone"),
        [],
      );
      assert.equal(
        (
          await f.query(
            a,
            "SELECT id FROM escalator_job WHERE kind='retention.sweep'",
          )
        ).length,
        2,
      );
    },
  );
  scenario(
    "reclaimed leases fence the old owner and exhausted work repairs with delayed progress",
    async (f, a) => {
      await seed(f, a);
      await initializeRetentionMaintenance(f.maintenance, a);
      const expired = await claim(f, a),
        before = (await f.maintenance.read(a))!;
      await f.query(
        a,
        "UPDATE escalator_job SET lease_expires_at=transaction_timestamp()-interval '1 second' WHERE __scope__=$1 AND id=$2 AND lease_token=$3",
        [a, expired.id, expired.token],
      );
      const replacement = await claim(f, a),
        jobs = new RetentionMaintenanceJobs(f.maintenance);
      assert.notEqual(replacement.token, expired.token);
      assert.deepEqual(await jobs.run(expired, new AbortController().signal), {
        state: "stale",
      });
      assert.deepEqual(await f.maintenance.read(a), before);
      assert.deepEqual(
        await jobs.run(replacement, new AbortController().signal),
        { state: "completed" },
      );
      assert.equal(await f.work.settle(expired, { state: "failed" }), false);
      assert.equal(
        await f.work.settle(replacement, { state: "completed" }),
        true,
      );
      const failed = await claim(f, a),
        position = (await f.maintenance.read(a))!;
      assert.equal(await f.work.settle(failed, { state: "failed" }), true);
      await initializeRetentionMaintenance(f.maintenance, a);
      const repaired = (await f.maintenance.read(a))!;
      assert.equal(repaired.revision, position.revision + 1);
      assert.equal(repaired.sourceId, position.sourceId);
      assert.deepEqual(repaired.after, position.after);
      assert.ok(
        Date.parse(repaired.dueAt) > Date.parse(position.dueAt) + 3599000,
      );
      assert.equal(
        await f.work.claim({
          workspaceId: a,
          queue: "job",
          token: randomUUID(),
          leaseMs: 30000,
          kinds: [retentionMaintenanceKind],
        }),
        undefined,
      );
      await initializeRetentionMaintenance(f.maintenance, a);
      assert.deepEqual(await f.maintenance.read(a), repaired);
      await f.detection.transaction(a, async (tx) =>
        assert.equal(
          (await tx.audit.list({ limit: 100 })).items.filter(
            (row) => row.action === "retention.maintenance.repaired",
          ).length,
          1,
        ),
      );
    },
  );

  scenario(
    "obsolete maintenance jobs expire by exact identity without deleting live or foreign work",
    async (f, a, b) => {
      await seed(f, a);
      await seed(f, b);
      await initializeRetentionMaintenance(f.maintenance, a);
      await initializeRetentionMaintenance(f.maintenance, b);
      const obsolete = (await f.maintenance.read(a))!;
      await step(f, a);
      await step(f, b);
      for (const scope of [a, b])
        await f.query(
          scope,
          "UPDATE escalator_job SET completed_at=transaction_timestamp()-interval '8 days' WHERE kind='retention.sweep' AND state='completed'",
        );
      await f.detection.transaction(a, async (tx) => {
        await tx.work.enqueue("job", {
          id: "retention.sweep:malformed",
          kind: "retention.sweep",
          idempotencyKey: "malformed",
          payload: { version: 999 },
          dueAt: tx.now,
        });
        await tx.work.enqueue("job", {
          id: "other-kind",
          kind: "other.kind",
          idempotencyKey: "other",
          payload: {},
          dueAt: tx.now,
        });
      });
      await f.query(
        a,
        "UPDATE escalator_job SET state='completed',completed_at=transaction_timestamp()-interval '8 days' WHERE id IN ('retention.sweep:malformed','other-kind')",
      );
      const lease = await claim(f, a),
        jobs = new RetentionMaintenanceJobs(f.maintenance);
      assert.deepEqual(await jobs.run(lease, new AbortController().signal), {
        state: "completed",
      });
      assert.deepEqual(
        await f.query(a, "SELECT id FROM escalator_job WHERE id=$1", [
          obsolete.jobId,
        ]),
        [],
      );
      assert.equal(
        (
          await f.query(
            a,
            "SELECT id FROM escalator_job WHERE id IN ('retention.sweep:malformed','other-kind')",
          )
        ).length,
        2,
      );
      assert.equal(
        (
          await f.query(
            b,
            "SELECT id FROM escalator_job WHERE kind='retention.sweep'",
          )
        ).length,
        2,
      );
      const after = (await f.maintenance.read(a))!;
      assert.equal(
        (
          await f.query(
            a,
            "SELECT id FROM escalator_job WHERE id=ANY($1::text[])",
            [[lease.id, after.jobId]],
          )
        ).length,
        2,
      );
      assert.deepEqual(await jobs.run(lease, new AbortController().signal), {
        state: "completed",
      });
      assert.equal(await f.work.settle(lease, { state: "completed" }), true);
      await f.detection.transaction(a, async (tx) => {
        const audit = (await tx.audit.list({ limit: 100 })).items.filter(
          (row) => row.action === "retention.jobs.pruned",
        );
        assert.equal(audit.length, 1);
        assert.deepEqual(audit[0]!.metadata, { deletedRows: 1 });
      });
    },
  );
  scenario(
    "obsolete job deletion rolls back if its audit cannot commit",
    async (f, a) => {
      await seed(f, a);
      await initializeRetentionMaintenance(f.maintenance, a);
      const obsolete = (await f.maintenance.read(a))!;
      await step(f, a);
      await f.query(
        a,
        "UPDATE escalator_job SET completed_at=transaction_timestamp()-interval '8 days' WHERE id=$1",
        [obsolete.jobId],
      );
      const before = (await f.maintenance.read(a))!;
      await f.detection.transaction(a, (tx) =>
        tx.audit.append({
          id: `retention-work-audit:${before.jobId}`,
          workspaceId: a,
          actor: { kind: "system", component: "test" },
          action: "test",
          subjectType: "workspace",
          subjectId: a,
          recordedAt: tx.now,
          metadata: {},
        }),
      );
      const lease = await claim(f, a);
      await assert.rejects(
        new RetentionMaintenanceJobs(f.maintenance).run(
          lease,
          new AbortController().signal,
        ),
      );
      assert.equal(
        (
          await f.query(a, "SELECT id FROM escalator_job WHERE id=$1", [
            obsolete.jobId,
          ])
        ).length,
        1,
      );
      assert.deepEqual(await f.maintenance.read(a), before);
      assert.equal(
        (
          await f.query(
            a,
            "SELECT id FROM escalator_job WHERE kind='retention.sweep'",
          )
        ).length,
        2,
      );
    },
  );
}
