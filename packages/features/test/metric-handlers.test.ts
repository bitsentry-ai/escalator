import test from "node:test";
import assert from "node:assert/strict";
import { withMetricHandlers } from "../src/application/metrics/handlers.js";
import type { MetricsRepository } from "../src/application/metrics/ports.js";
import type { WorkHandler } from "../src/application/jobs/runner.js";
test("metric registration preserves independent monitoring and outbox handlers without I/O", () => {
  let reads = 0;
  const repository = {
    transaction: async () => {
      reads++;
      throw new Error("unexpected database call");
    },
  } as MetricsRepository;
  const handler: WorkHandler = async () => ({ state: "completed" });
  const base = {
    job: new Map([["signal.process", handler]]),
    outbox: new Map([["deliver", handler]]),
  };
  const combined = withMetricHandlers(base, repository, {
    read: async () => {
      throw new Error("unexpected network call");
    },
  });
  assert.equal(combined.job.get("signal.process"), handler);
  assert.equal(combined.outbox, base.outbox);
  assert.equal(typeof combined.job.get("metrics.poll"), "function");
  assert.equal(base.job.size, 1);
  assert.equal(reads, 0);
  assert.throws(
    () =>
      withMetricHandlers(combined, repository, {
        read: async () => {
          throw new Error("metrics read failed");
        },
      }),
    /already registered/,
  );
});
