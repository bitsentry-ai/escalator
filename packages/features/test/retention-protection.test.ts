import test from "node:test";
import assert from "node:assert/strict";
import { workspaceIdSchema } from "../src/contracts/index.js";
import { replayReceiptProtection } from "../src/application/retention/protection.js";
import { metricJobId } from "../src/application/metrics/schedule.js";
import { MemoryMetricsRepository } from "./conformance/memory-metrics.js";
import { seedMetricFixture } from "./conformance/metrics.js";
const scope = workspaceIdSchema.parse("protection"),
  now = "2026-10-03T12:00:00.000Z";
test("reference, processed and terminal-work protection apply in either host", () => {
  const protect = replayReceiptProtection(scope, null, now);
  const receipt = {
    kind: "signal" as const,
    id: "event",
    observedAt: now,
    referenced: false,
    processed: true,
  };
  const work = {
    id: "signal.process:event",
    kind: "signal.process",
    state: "completed",
    payload: { signalId: "event" },
    leaseToken: null,
    leaseExpiresAt: null,
    completedAt: now,
  };
  assert.equal(protect(receipt, work), false);
  assert.equal(protect({ ...receipt, referenced: true }, work), true);
  assert.equal(protect({ ...receipt, processed: false }, work), true);
  assert.equal(protect(receipt, undefined), true);
});
test("live metric protection includes late evaluation, is versioned and ends when disabled", async () => {
  const repository = new MemoryMetricsRepository(() => new Date(now));
  const monitor = await repository.transaction(scope, seedMetricFixture);
  const protect = replayReceiptProtection(scope, monitor, now);
  const check = (at: string, version = 1, enabled = true) => {
    const id = metricJobId(scope, monitor.id, version, at);
    const receipt = {
      kind: "metric" as const,
      id,
      ownerId: monitor.id,
      version,
      observedAt: at,
      referenced: false,
      processed: true,
    };
    const work = {
      id,
      kind: "metrics.poll",
      state: "completed",
      payload: {
        monitorId: monitor.id,
        monitorVersion: version,
        dueAt: at,
        secretIds: [],
      },
      leaseToken: null,
      leaseExpiresAt: null,
      completedAt: now,
    };
    return (
      enabled
        ? protect
        : replayReceiptProtection(scope, { ...monitor, enabled: false }, now)
    )(receipt, work);
  };
  assert.equal(check("2026-10-03T11:56:59.999Z"), false);
  assert.equal(check("2026-10-03T11:57:00.000Z"), true);
  assert.equal(check(now), true);
  assert.equal(check(now, 2), false);
  assert.equal(check(now, 1, false), false);
  assert.throws(() =>
    replayReceiptProtection(workspaceIdSchema.parse("other"), monitor, now),
  );
});
