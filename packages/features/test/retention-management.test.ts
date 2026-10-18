import test from "node:test";
import assert from "node:assert/strict";
import { RetentionManagement } from "../src/application/retention/management.js";
import { MaintenanceAdmission } from "../src/application/retention/runtime.js";
import {
  workspaceIdSchema,
  responderIdSchema,
  defaultReplayRetention,
  type Actor,
} from "../src/contracts/index.js";
const actor: Actor = {
  workspaceId: workspaceIdSchema.parse("team"),
  responderId: responderIdSchema.parse("owner"),
  role: "administrator",
};
const input = { ...defaultReplayRetention, expectedVersion: null };
const query = {
  kind: "probe" as const,
  id: "probe",
  startAt: "2026-10-01T00:00:00.000Z",
  endAt: "2026-10-02T00:00:00.000Z",
  visibleAt: "2026-10-02T00:00:00.000Z",
};
function fixture() {
  const seen: Actor[] = [];
  const gate = new MaintenanceAdmission();
  const value = {
    configured: null,
    effective: { ...defaultReplayRetention },
    limits: { ...defaultReplayRetention },
  };
  const management = new RetentionManagement(
    {
      get: async (a) => {
        seen.push(a);
        return value;
      },
      save: async (a) => {
        seen.push(a);
        return {
          ...value,
          configured: {
            ...defaultReplayRetention,
            workspaceId: a.workspaceId,
            version: 1,
            updatedAt: "2026-10-04T00:00:00.000Z",
          },
        };
      },
    },
    {
      read: async (a) => {
        seen.push(a);
        throw new Error("repository failure");
      },
    },
    gate,
  );
  return { seen, gate, management };
}
test("settings remain usable while maintenance capacity gates coverage", async () => {
  const f = fixture();
  let release!: () => void;
  const held = f.gate.tryRun(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  assert.ok(await f.management.get(actor));
  assert.ok(await f.management.update(actor, input));
  await assert.rejects(f.management.report(actor, query), {
    code: "retention_busy",
  });
  assert.deepEqual(f.seen, [actor, actor]);
  release();
  await held;
});
test("authorization and strict input validation happen before maintenance admission", async () => {
  const f = fixture();
  let release!: () => void;
  const held = f.gate.tryRun(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  assert.throws(
    () => f.management.update({ ...actor, role: "viewer" }, input),
    { code: "forbidden" },
  );
  assert.throws(() =>
    f.management.update(actor, { ...input, workspaceId: "foreign" } as never),
  );
  assert.throws(() =>
    f.management.report(actor, { ...query, workspaceId: "foreign" } as never),
  );
  assert.deepEqual(f.seen, []);
  release();
  await held;
  await f.management.update(actor, input);
  assert.deepEqual(f.seen, [actor]);
});
test("a failed coverage query releases capacity for subsequent settings reads", async () => {
  const f = fixture();
  await assert.rejects(f.management.report(actor, query), /repository failure/);
  await f.management.get(actor);
  assert.deepEqual(f.seen, [actor, actor]);
});
