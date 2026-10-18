import test from "node:test";
import assert from "node:assert/strict";
import { heartbeatSchema } from "../src/contracts/heartbeat.js";
import {
  configureHeartbeat,
  acceptHeartbeat,
  missHeartbeat,
} from "../src/application/probes/heartbeat.js";
const now = "2026-10-03T00:00:00.000Z";
const config = heartbeatSchema.parse({
  id: "cron",
  sourceId: "source",
  workspaceId: "local",
  serviceId: "api",
  environmentId: "prod",
  name: "Cron",
  enabled: true,
  intervalSeconds: 60,
  graceSeconds: 10,
  version: 1,
  createdAt: now,
  updatedAt: now,
});
test("misses use absolute grace deadlines and never recover from silence", () => {
  const initial = configureHeartbeat(config, undefined, now);
  assert.equal(initial.deadlineAt, "2026-10-03T00:01:10.000Z");
  assert.equal(
    missHeartbeat(
      config,
      initial,
      initial.deadlineJobId!,
      "2026-10-03T00:01:09.999Z",
    ),
    undefined,
  );
  assert.equal(
    missHeartbeat(config, initial, initial.deadlineJobId!, initial.deadlineAt!),
    undefined,
  );
  const missed = missHeartbeat(
    config,
    initial,
    initial.deadlineJobId!,
    "2026-10-03T00:01:10.001Z",
  )!;
  assert.equal(missed.missedAt, initial.deadlineAt);
  assert.equal(missed.lastAcceptedAt, null);
  assert.equal(
    missHeartbeat(
      config,
      missed,
      initial.deadlineJobId!,
      "2026-10-03T00:10:00.000Z",
    ),
    undefined,
  );
  const disabled = configureHeartbeat(
    { ...config, version: 2, enabled: false },
    missed,
    "2026-10-03T00:11:00.000Z",
  );
  assert.equal(disabled.missedAt, missed.missedAt);
  assert.equal(disabled.deadlineAt, null);
});
test("late ping supersedes an obsolete miss and explicitly recovers a committed miss", () => {
  const initial = configureHeartbeat(config, undefined, now);
  const at = "2026-10-03T00:02:00.000Z";
  const ping = { version: 1 as const, eventId: "ping", observedAt: at };
  const accepted = acceptHeartbeat(config, initial, ping, at);
  assert.equal(
    missHeartbeat(config, accepted, initial.deadlineJobId!, at),
    undefined,
  );
  assert.equal(accepted.deadlineAt, "2026-10-03T00:03:10.000Z");
  const missed = missHeartbeat(config, initial, initial.deadlineJobId!, at)!;
  assert.equal(acceptHeartbeat(config, missed, ping, at).missedAt, null);
});
test("old, future and out-of-order events cannot extend heartbeat liveness", () => {
  const initial = configureHeartbeat(config, undefined, now);
  const accepted = acceptHeartbeat(
    config,
    initial,
    { version: 1, eventId: "one", observedAt: now },
    now,
  );
  for (const observedAt of [
    now,
    "2026-10-02T23:50:00.000Z",
    "2026-10-03T00:10:00.000Z",
  ])
    assert.throws(
      () =>
        acceptHeartbeat(
          config,
          accepted,
          { version: 1, eventId: "two", observedAt },
          "2026-10-03T00:00:10.000Z",
        ),
      { code: "stale_ping" },
    );
  assert.throws(
    () =>
      acceptHeartbeat(
        { ...config, enabled: false },
        accepted,
        { version: 1, eventId: "two", observedAt: now },
        now,
      ),
    { code: "disabled" },
  );
});
