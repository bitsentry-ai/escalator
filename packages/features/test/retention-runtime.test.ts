import test from "node:test";
import assert from "node:assert/strict";
import { workspaceIdSchema } from "../src/contracts/index.js";
import {
  MaintenanceAdmission,
  RetentionCoordinator,
  withRetentionHandlers,
} from "../src/application/retention/runtime.js";
import {
  retentionMaintenanceKind,
  type RetentionMaintenanceRepository,
} from "../src/application/retention/maintenance.js";
import type { WorkLease } from "../src/application/jobs/ports.js";
import type { WorkHandlers } from "../src/application/jobs/scheduler.js";
const a = workspaceIdSchema.parse("maintenance_a"),
  b = workspaceIdSchema.parse("maintenance_b");
function hold(gate: MaintenanceAdmission) {
  let release!: () => void;
  const pending = gate.tryRun(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  return { pending, release };
}
test("maintenance admission does not queue and releases its slot after success and failure", async () => {
  const gate = new MaintenanceAdmission(),
    first = hold(gate);
  let ran = false;
  assert.deepEqual(
    await gate.tryRun(async () => {
      ran = true;
    }),
    { accepted: false },
  );
  assert.equal(ran, false);
  first.release();
  await first.pending;
  await assert.rejects(
    gate.tryRun(async () => {
      throw new Error("failed operation");
    }),
  );
  assert.deepEqual(await gate.tryRun(async () => 7), {
    accepted: true,
    value: 7,
  });
});
test("busy maintenance handlers wait without executing and aborted work never enters the gate", async () => {
  const gate = new MaintenanceAdmission(),
    held = hold(gate);
  let runs = 0;
  const jobs = {
    run: async () => {
      runs++;
      return { state: "completed" as const };
    },
  };
  const base: WorkHandlers = { job: new Map(), outbox: new Map() };
  const handlers = withRetentionHandlers(base, jobs, gate);
  const lease: WorkLease = {
    workspaceId: a,
    queue: "job",
    id: "job",
    kind: retentionMaintenanceKind,
    payload: {},
    token: "claim",
    attempt: 1,
    dueAt: "2026-10-04T00:00:00.000Z",
    leaseExpiresAt: "2026-10-04T00:00:30.000Z",
  };
  const run = handlers.job.get(retentionMaintenanceKind)!;
  assert.deepEqual(await run(lease, new AbortController().signal), {
    state: "wait",
    delayMs: 5000,
  });
  assert.equal(runs, 0);
  held.release();
  await held.pending;
  const abort = new AbortController();
  abort.abort();
  assert.deepEqual(await run(lease, abort.signal), { state: "stale" });
  assert.equal(runs, 0);
  assert.deepEqual(await run(lease, new AbortController().signal), {
    state: "completed",
  });
  assert.equal(runs, 1);
  assert.equal(handlers.outbox, base.outbox);
  assert.equal(base.job.size, 0);
  assert.throws(() => withRetentionHandlers(handlers, jobs, gate));
});
test("coordinator rotates past busy and failing scopes without starting during construction", async () => {
  const gate = new MaintenanceAdmission(),
    seen: string[] = [];
  const repository: RetentionMaintenanceRepository = {
    read: async () => undefined,
    transaction: async (scope) => {
      seen.push(scope);
      throw new Error("database unavailable");
    },
  };
  const coordinator = new RetentionCoordinator(
    repository,
    [a, b],
    gate,
    () => {},
  );
  assert.deepEqual(seen, []);
  const held = hold(gate);
  await coordinator.tick();
  assert.deepEqual(seen, []);
  held.release();
  await held.pending;
  await assert.rejects(coordinator.tick());
  await assert.rejects(coordinator.tick());
  assert.deepEqual(seen, [b, a]);
  await coordinator.stop();
  const empty = new RetentionCoordinator(repository, [], gate, () => {});
  await empty.tick();
  await empty.stop();
  assert.throws(
    () => new RetentionCoordinator(repository, [a, a], gate, () => {}),
  );
  assert.throws(
    () =>
      new RetentionCoordinator(
        repository,
        Array.from({ length: 101 }, (_, i) =>
          workspaceIdSchema.parse(`tenant_${i}`),
        ),
        gate,
        () => {},
      ),
  );
});

test("shutdown drain waits for the operation after its caller stops waiting", async () => {
  const gate = new MaintenanceAdmission(),
    held = hold(gate);
  let drained = false;
  const drain = gate.drain().then(() => {
    drained = true;
  });
  await Promise.resolve();
  assert.equal(drained, false);
  held.release();
  await held.pending;
  await drain;
  assert.equal(drained, true);
});
