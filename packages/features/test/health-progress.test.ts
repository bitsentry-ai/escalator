import test from "node:test";
import assert from "node:assert/strict";
import { SchedulerProgress } from "../src/application/health/progress.js";
test("scheduler health requires actual completed operations in every lane", () => {
  let now = 0;
  const progress = new SchedulerProgress(2, () => now);
  assert.deepEqual(progress.snapshot(), {
    running: false,
    laneAgeMs: [null, null],
  });
  progress.start();
  now = 5000;
  assert.deepEqual(progress.snapshot(), {
    running: true,
    laneAgeMs: [null, null],
  });
  progress.record(0, "completed");
  progress.record(1, "idle");
  now = 8000;
  assert.deepEqual(progress.snapshot(), {
    running: true,
    laneAgeMs: [3000, 3000],
  });
  progress.record(0, "failed");
  progress.record(1, "stale");
  now = 12000;
  assert.deepEqual(progress.snapshot().laneAgeMs, [7000, 7000]);
  progress.stop();
  progress.record(0, "completed");
  assert.equal(progress.snapshot().running, false);
  progress.start();
  assert.deepEqual(progress.snapshot().laneAgeMs, [null, null]);
});
test("scheduler health treats invalid or reversed clocks as unknown", () => {
  let now = 100;
  const progress = new SchedulerProgress(1, () => now);
  progress.start();
  progress.record(0, "completed");
  now = 99;
  assert.deepEqual(progress.snapshot().laneAgeMs, [null]);
  now = Number.NaN;
  assert.deepEqual(progress.snapshot().laneAgeMs, [null]);
});
