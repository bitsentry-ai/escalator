import test from "node:test";
import assert from "node:assert/strict";
import {
  createMonitoringHandlers,
  monitoringJobLanes,
  DurableWorkScheduler,
} from "../src/application/index.js";
import { workspaceIdSchema } from "../src/contracts/index.js";
import { MemoryDetectionRepository } from "./conformance/memory-detection.js";
test("combined monitoring handlers register every lane without starting work", async () => {
  const repository = new MemoryDetectionRepository();
  const handlers = createMonitoringHandlers(
    repository,
    {} as Parameters<typeof createMonitoringHandlers>[1],
    "https://example.test",
  );
  assert.deepEqual([...handlers.job.keys()].sort(), [
    "paging.cancel",
    "paging.receipt",
    "paging.step",
    "signal.process",
    "signal.recover",
  ]);
  assert.deepEqual([...handlers.outbox.keys()], ["paging.send"]);
  let claims = 0;
  const scheduler = new DurableWorkScheduler(
    {
      claim: async () => {
        claims++;
        return undefined;
      },
      settle: async () => true,
    },
    workspaceIdSchema.parse("local"),
    handlers,
    {
      leaseMs: 30000,
      timeoutMs: 20000,
      maxAttempts: 5,
      retryBaseMs: 1000,
      retryMaxMs: 60000,
      token: () => "test",
      random: () => 0.5,
    },
    {
      intervalMs: 5000,
      batchSize: 10,
      onError: () => {
        throw new Error("unexpected");
      },
      jobLanes: monitoringJobLanes,
    },
  );
  await scheduler.stop();
  assert.equal(claims, 0);
  assert.equal(
    monitoringJobLanes.flat().filter((kind) => kind === "signal.process")
      .length,
    1,
  );
  assert.equal(
    monitoringJobLanes.flat().filter((kind) => kind === "signal.recover")
      .length,
    1,
  );
});
