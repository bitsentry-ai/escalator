import test from "node:test";
import assert from "node:assert/strict";
import { withProbeHandlers } from "../src/application/probes/handlers.js";
import type { ProbeRepository } from "../src/application/probes/ports.js";
import type { WorkHandler } from "../src/application/jobs/runner.js";
test("probe registration preserves independent monitoring and outbox handlers without I/O", () => {
  let reads = 0;
  const repository = {
    transaction: async () => {
      reads++;
      throw new Error("unexpected database call");
    },
  } as ProbeRepository;
  const handler: WorkHandler = async () => ({ state: "completed" });
  const base = {
    job: new Map([["signal.process", handler]]),
    outbox: new Map([["deliver", handler]]),
  };
  const combined = withProbeHandlers(base, repository, {
    run: async () => {
      throw new Error("unexpected network call");
    },
  });
  assert.equal(combined.job.get("signal.process"), handler);
  assert.equal(combined.outbox, base.outbox);
  assert.equal(typeof combined.job.get("probe.execute"), "function");
  assert.equal(base.job.size, 1);
  assert.equal(reads, 0);
  assert.throws(
    () =>
      withProbeHandlers(combined, repository, {
        run: async () => {
          throw new Error();
        },
      }),
    /already registered/,
  );
});
