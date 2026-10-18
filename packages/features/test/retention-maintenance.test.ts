import test from "node:test";
import assert from "node:assert/strict";
import { workspaceIdSchema, workspaceSchema } from "../src/contracts/index.js";
import {
  RetentionMaintenanceJobs,
  initializeRetentionMaintenance,
  retentionMaintenanceKind,
  retentionMaintenanceTransaction,
  type RetentionMaintenanceState,
  type RetentionMaintenanceRepository,
  type RetentionMaintenanceTransaction,
} from "../src/application/retention/maintenance.js";
import { replayPruneTransaction } from "../src/application/retention/pruning-transaction.js";
import type { ReplayPruneSnapshot } from "../src/application/retention/pruning.js";
import { MemoryFoundationRepository } from "./conformance/memory.js";
const scope = workspaceIdSchema.parse("maintenance");
type Data = {
  state?: RetentionMaintenanceState;
  sources: string[];
  rows: ReplayPruneSnapshot["candidates"];
  bytes: number;
  retiredRows?: number;
};
async function fixture(count = 105, sources = ["a"]) {
  let now = Date.parse("2026-10-03T12:00:00.000Z"),
    failSuccessor = false;
  const foundation = new MemoryFoundationRepository({
    now: () => new Date(now),
  });
  await foundation.withExtensions(scope, async (tx, extra) => {
    await tx.workspace.insert(
      workspaceSchema.parse({
        id: scope,
        name: "Team",
        createdAt: tx.now,
        updatedAt: tx.now,
      }),
    );
    extra.maintenance = {
      [scope]: {
        sources,
        bytes: count * 10,
        rows: Array.from({ length: count }, (_, i) => ({
          workspaceId: scope,
          sourceId: sources[0],
          id: `event-${String(i).padStart(4, "0")}`,
          kind: "signal",
          observedAt: "2026-08-01T00:00:00.000Z",
          bytes: 10,
          protected: false,
        })),
      },
    };
  });
  const repository: RetentionMaintenanceRepository = {
    read: (workspace) =>
      foundation.withExtensions(workspace, async (_, extra) =>
        structuredClone(
          (extra.maintenance as Record<string, Data>)[workspace]?.state,
        ),
      ),
    transaction: (workspace, source, run) =>
      foundation.withExtensions(
        workspace,
        async (base, extra, guard, workRecords) => {
          const data = (((extra.maintenance ??= {}) as Record<string, Data>)[
            workspace
          ] ??= { sources: [], rows: [], bytes: 0 });
          let locked = false;
          const prune = replayPruneTransaction(
            base,
            {
              snapshot: async (after) => {
                const rows = data.rows.filter(
                  (row) =>
                    row.sourceId === source && (!after || row.id > after.id),
                );
                return {
                  databaseNow: base.now,
                  retainedBytes: data.bytes,
                  policy: null,
                  candidates: rows.slice(0, 1000),
                  hasMore: rows.length > 1000,
                };
              },
              remove: async (selected) => {
                const ids = new Set(selected.map((row) => row.id));
                const rows = data.rows.filter(
                  (row) => row.sourceId === source && ids.has(row.id),
                );
                const bytes = rows.reduce((sum, row) => sum + row.bytes, 0);
                data.rows = data.rows.filter(
                  (row) => !(row.sourceId === source && ids.has(row.id)),
                );
                data.bytes -= bytes;
                return {
                  deletedRows: rows.length,
                  deletedBytes: bytes,
                  retainedBytes: data.bytes,
                };
              },
            },
            guard,
          );
          return run(
            retentionMaintenanceTransaction(
              prune,
              {
                lock: () =>
                  guard.operation(async () => {
                    locked = true;
                    return structuredClone(data.state);
                  }),
                retireWork: async () => {
                  const count = data.retiredRows ?? 0;
                  data.retiredRows = 0;
                  return count;
                },
                lockWork: async (id) => {
                  const row = workRecords.find(
                    (value) => value.queue === "job" && value.intent.id === id,
                  );
                  return row
                    ? {
                        kind: row.intent.kind,
                        state: row.state,
                        payload: row.intent.payload,
                      }
                    : undefined;
                },
                put: (value, expected) =>
                  guard.operation(async () => {
                    if (!locked) throw new Error("Missing schedule lock");
                    if (failSuccessor)
                      throw new Error("Injected schedule failure");
                    if ((data.state?.revision ?? null) !== expected)
                      return false;
                    data.state = structuredClone(value);
                    return true;
                  }),
                nextSource: (after) =>
                  guard.operation(
                    async () =>
                      data.sources
                        .filter((id) => after === null || id > after)
                        .sort()[0],
                  ),
              },
              guard,
            ),
          );
        },
      ),
  };
  const jobs = new RetentionMaintenanceJobs(repository);
  const claim = async () => {
    const lease = await foundation.claim({
      workspaceId: scope,
      queue: "job",
      token: `owner-${now}`,
      leaseMs: 30000,
      kinds: [retentionMaintenanceKind],
    });
    assert.ok(lease);
    return lease;
  };
  const step = async () => {
    const lease = await claim();
    const result = await jobs.run(lease, new AbortController().signal);
    assert.equal(result.state, "completed");
    await foundation.settle(lease, { state: "completed" });
    now += 1000;
    return lease;
  };
  const read = () =>
    foundation.withExtensions(scope, async (_, extra) =>
      structuredClone((extra.maintenance as Record<string, Data>)[scope]),
    );
  return {
    foundation,
    repository,
    jobs,
    claim,
    step,
    read,
    advance: (ms: number) => {
      now += ms;
    },
    retired: (count: number) =>
      foundation.withExtensions(scope, async (_, extra) => {
        (extra.maintenance as Record<string, Data>)[scope]!.retiredRows = count;
      }),
    fail: (value: boolean) => {
      failSuccessor = value;
    },
  };
}
test("concurrent initialization does not replace the durable cursor or create another intent", async () => {
  const f = await fixture();
  await Promise.all([
    initializeRetentionMaintenance(f.repository, scope),
    initializeRetentionMaintenance(f.repository, scope),
  ]);
  assert.equal((await f.read()).state?.revision, 1);
  await f.step();
  const before = await f.read();
  await initializeRetentionMaintenance(f.repository, scope);
  assert.deepEqual(await f.read(), before);
});
test("bounded batches and empty sources advance atomically and finish a sweep", async () => {
  const f = await fixture(105, ["a", "b"]);
  await initializeRetentionMaintenance(f.repository, scope);
  await f.step(); // control -> a
  await f.step(); // deletes100
  assert.equal((await f.read()).rows.length, 5);
  assert.equal((await f.read()).state?.sourceId, "a");
  await f.step(); // deletes5 -> b
  assert.equal((await f.read()).state?.sourceId, "b");
  await f.step(); // empty b -> delayed next sweep
  const final = await f.read();
  assert.equal(final.bytes, 0);
  assert.equal(final.state?.sourceId, null);
  assert.ok(final.state?.completedAt);
  await f.foundation.transaction(scope, async (tx) =>
    assert.equal((await tx.audit.list({ limit: 100 })).items.length, 2),
  );
});
test("a crash before settlement does not repeat a committed batch", async () => {
  const f = await fixture();
  await initializeRetentionMaintenance(f.repository, scope);
  await f.step();
  const lease = await f.claim();
  await f.jobs.run(lease, new AbortController().signal);
  const committed = await f.read();
  assert.equal(committed.rows.length, 5);
  assert.deepEqual(await f.jobs.run(lease, new AbortController().signal), {
    state: "completed",
  });
  assert.deepEqual(await f.read(), committed);
});
test("a successor failure rolls back deletion, accounting, audit and schedule", async () => {
  const f = await fixture();
  await initializeRetentionMaintenance(f.repository, scope);
  await f.step();
  const lease = await f.claim(),
    before = await f.read();
  f.fail(true);
  await assert.rejects(f.jobs.run(lease, new AbortController().signal));
  assert.deepEqual(await f.read(), before);
  await f.foundation.transaction(scope, async (tx) =>
    assert.equal((await tx.audit.list({ limit: 100 })).items.length, 0),
  );
  f.fail(false);
  await f.jobs.run(lease, new AbortController().signal);
  assert.equal((await f.read()).rows.length, 5);
});
test("expired claims and caller-forged payloads cannot choose a source or cursor", async () => {
  const f = await fixture();
  await initializeRetentionMaintenance(f.repository, scope);
  const lease = await f.claim();
  assert.deepEqual(
    await f.jobs.run(
      { ...lease, payload: { sourceId: "foreign", revision: 999 } },
      new AbortController().signal,
    ),
    { state: "completed" },
  );
  assert.equal((await f.read()).state?.sourceId, "a");
  await f.foundation.settle(lease, { state: "completed" });
  f.advance(1000);
  const expired = await f.claim(),
    before = await f.read();
  f.advance(30000);
  assert.deepEqual(await f.jobs.run(expired, new AbortController().signal), {
    state: "stale",
  });
  assert.deepEqual(await f.read(), before);
});
test("a committed deletion can retain a null cursor while revisiting an earlier physical receipt", async () => {
  const f = await fixture(101);
  await f.foundation.withExtensions(scope, async (_, extra) => {
    const data = (extra.maintenance as Record<string, Data>)[scope];
    data.rows[0] = {
      ...data.rows[0],
      id: "z",
      kind: "signal",
      observedAt: "2026-08-01T00:00:00.000001Z",
    };
    for (let i = 1; i < data.rows.length; i++)
      data.rows[i] = {
        ...data.rows[i],
        kind: "probe",
        observedAt: "2026-08-01T00:00:00.000002Z",
      };
  });
  await initializeRetentionMaintenance(f.repository, scope);
  await f.step();
  await f.step();
  const middle = await f.read();
  assert.equal(middle.rows.length, 1);
  assert.equal(middle.state?.after, null);
  assert.equal(middle.state?.sourceId, "a");
  await f.step();
  assert.equal((await f.read()).rows.length, 0);
});
test("maintenance state is isolated by workspace and caught conflicts poison writes", async () => {
  const f = await fixture(1);
  const other = workspaceIdSchema.parse("other-maintenance");
  await f.foundation.transaction(other, (tx) =>
    tx.workspace.insert(
      workspaceSchema.parse({
        id: other,
        name: "Other",
        createdAt: tx.now,
        updatedAt: tx.now,
      }),
    ),
  );
  await initializeRetentionMaintenance(f.repository, scope);
  await initializeRetentionMaintenance(f.repository, other);
  const before = await f.repository.read(other);
  await f.step();
  assert.deepEqual(await f.repository.read(other), before);
  await assert.rejects(
    f.repository.transaction(scope, "a", async (tx) => {
      const state = (await tx.maintenance.lock())!;
      await tx.audit.append({
        id: "rollback",
        workspaceId: scope,
        actor: { kind: "system", component: "test" },
        action: "test",
        subjectType: "retention",
        subjectId: "schedule",
        recordedAt: tx.now,
        metadata: {},
      });
      await assert.rejects(
        tx.maintenance.put({ ...state, workspaceId: other }, state.revision),
      );
    }),
  );
  await f.foundation.transaction(scope, async (tx) =>
    assert.equal((await tx.audit.list({ limit: 100 })).items.length, 0),
  );
});
test("maintenance transaction handles expire and schedule locks cannot be reused", async () => {
  const f = await fixture(0);
  await initializeRetentionMaintenance(f.repository, scope);
  let escaped: RetentionMaintenanceTransaction;
  await f.repository.transaction(scope, null, async (tx) => {
    escaped = tx;
    await tx.maintenance.lock();
  });
  await assert.rejects(escaped!.maintenance.lock());
  await assert.rejects(
    f.repository.transaction(scope, null, async (tx) => {
      await tx.maintenance.lock();
      await assert.rejects(tx.maintenance.lock());
    }),
  );
});
test("failed maintenance is repaired with backoff while preserving its source and cursor", async () => {
  const f = await fixture();
  await initializeRetentionMaintenance(f.repository, scope);
  await f.step();
  const lease = await f.claim();
  assert.equal(await f.foundation.settle(lease, { state: "failed" }), true);
  const before = await f.read();
  await initializeRetentionMaintenance(f.repository, scope);
  const repaired = await f.read();
  assert.equal(repaired.state!.revision, before.state!.revision + 1);
  assert.equal(repaired.state!.sourceId, before.state!.sourceId);
  assert.deepEqual(repaired.state!.after, before.state!.after);
  assert.deepEqual(repaired.rows, before.rows);
  assert.equal(
    Date.parse(repaired.state!.dueAt) - Date.parse(before.state!.dueAt),
    3600000,
  );
  assert.equal(
    await f.foundation.claim({
      workspaceId: scope,
      queue: "job",
      token: "early",
      leaseMs: 30000,
      kinds: [retentionMaintenanceKind],
    }),
    undefined,
  );
  await initializeRetentionMaintenance(f.repository, scope);
  assert.deepEqual(await f.read(), repaired);
  f.advance(3600000);
  await f.step();
  assert.equal((await f.read()).rows.length, 5);
  await f.foundation.transaction(scope, async (tx) =>
    assert.equal(
      (await tx.audit.list({ limit: 100 })).items.filter(
        (row) => row.action === "retention.maintenance.repaired",
      ).length,
      1,
    ),
  );
});
test("cancelled handlers and invalid deployment cadences leave persisted state untouched", async () => {
  const f = await fixture();
  await initializeRetentionMaintenance(f.repository, scope);
  const lease = await f.claim(),
    before = await f.read();
  const abort = new AbortController();
  abort.abort();
  assert.deepEqual(await f.jobs.run(lease, abort.signal), { state: "stale" });
  assert.deepEqual(await f.read(), before);
  assert.throws(() => new RetentionMaintenanceJobs(f.repository, 1));
  assert.throws(() => new RetentionMaintenanceJobs(f.repository, 3600000, 0));
  await assert.rejects(initializeRetentionMaintenance(f.repository, scope, 1));
});

test("retired jobs share the batch audit and successor transaction", async () => {
  const f = await fixture();
  await initializeRetentionMaintenance(f.repository, scope);
  await f.step();
  await f.retired(3);
  const lease = await f.claim();
  const before = await f.read();
  f.fail(true);
  await assert.rejects(f.jobs.run(lease, new AbortController().signal));
  assert.deepEqual(await f.read(), before);
  f.fail(false);
  assert.deepEqual(await f.jobs.run(lease, new AbortController().signal), {
    state: "completed",
  });
  assert.equal((await f.read()).retiredRows, 0);
  assert.deepEqual(await f.jobs.run(lease, new AbortController().signal), {
    state: "completed",
  });
  await f.foundation.transaction(scope, async (tx) => {
    const records = (await tx.audit.list({ limit: 100 })).items.filter(
      (row) => row.action === "retention.jobs.pruned",
    );
    assert.equal(records.length, 1);
    assert.deepEqual(records[0]!.metadata, { deletedRows: 3 });
  });
});
test("retired work cleanup rejects repeated calls and calls after accounting starts", async () => {
  const f = await fixture();
  await initializeRetentionMaintenance(f.repository, scope);
  await f.step();
  await f.retired(2);
  const before = await f.read();
  await assert.rejects(
    f.repository.transaction(scope, "a", async (tx) => {
      await tx.maintenance.lock();
      await tx.retentionPrune.snapshot(null);
      await assert.rejects(tx.maintenance.retireWork());
    }),
  );
  assert.deepEqual(await f.read(), before);
  await assert.rejects(
    f.repository.transaction(scope, "a", async (tx) => {
      await tx.maintenance.lock();
      assert.equal(await tx.maintenance.retireWork(), 2);
      await assert.rejects(tx.maintenance.retireWork());
    }),
  );
  assert.deepEqual(await f.read(), before);
  await f.retired(101);
  const invalid = await f.read();
  const lease = await f.claim();
  await assert.rejects(f.jobs.run(lease, new AbortController().signal));
  assert.deepEqual(await f.read(), invalid);
});
