/* Operator-only preload: never imported by application startup by default. */
const process = require("node:process");
const { monitorEventLoopDelay, performance } = require("node:perf_hooks");
const { isAbsolute } = require("node:path");
const output = process.env.ESCALATOR_CAPACITY_PROCESS_OUTPUT;
const label = process.env.ESCALATOR_CAPACITY_PROCESS_LABEL;
if (
  process.env.ESCALATOR_CAPACITY_DISPOSABLE !== "1" ||
  !output ||
  !isAbsolute(output) ||
  !["standalone", "dashboard-backend", "dashboard-worker"].includes(label)
)
  throw new Error(
    "Capacity preload requires explicit disposable configuration and a private output path",
  );
// Exclusive creation prevents overwriting another process or a previous run.
const { openSync, writeFileSync, closeSync } = require("node:fs");
const fd = openSync(output, "wx", 0o600);
const histogram = monitorEventLoopDelay({ resolution: 20 });
histogram.enable();
const start = performance.now();
let previousTime = start,
  previousCpu = process.cpuUsage(),
  count = 0,
  closed = false;
writeFileSync(
  fd,
  JSON.stringify({
    formatVersion: 1,
    measurement: "process_resource_samples",
    label,
    pid: process.pid,
    intervalMs: 5000,
    maxSamples: 1440,
    startedAt: new Date().toISOString(),
  }) + "\n",
);
function sample() {
  if (closed) return;
  const now = performance.now(),
    cpu = process.cpuUsage(),
    memory = process.memoryUsage();
  const elapsedMs = now - previousTime;
  const record = {
    at: new Date().toISOString(),
    elapsedMs,
    uptimeMs: now - start,
    cpuUserMicros: cpu.user - previousCpu.user,
    cpuSystemMicros: cpu.system - previousCpu.system,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    eventLoopSamples: histogram.count,
    eventLoopP95Ms: histogram.count ? histogram.percentile(95) / 1e6 : null,
    eventLoopMaxMs: histogram.count ? histogram.max / 1e6 : null,
  };
  writeFileSync(fd, JSON.stringify(record) + "\n");
  previousCpu = cpu;
  previousTime = now;
  histogram.reset();
  count++;
  if (count >= 1440) finish("sample_limit");
}
function finish(reason) {
  if (closed) return;
  closed = true;
  clearInterval(timer);
  histogram.disable();
  try {
    writeFileSync(
      fd,
      JSON.stringify({
        finishedAt: new Date().toISOString(),
        reason,
        samples: count,
      }) + "\n",
    );
  } finally {
    closeSync(fd);
  }
}
const timer = setInterval(() => {
  try {
    sample();
  } catch {
    try {
      finish("write_failed");
    } catch {
      /* Do not crash the observed process. */
    }
  }
}, 5000);
timer.unref();
process.once("exit", () => {
  try {
    finish("process_exit");
  } catch {
    /* Output may be incomplete; no signal handler or exit override. */
  }
});
