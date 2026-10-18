import test from "node:test";
import assert from "node:assert/strict";
import { StandaloneRetentionResources } from "../../src/features/retention/resources.js";
test("maintenance owns one lazy connection and contains pool-error observers", async () => {
  let errors = 0;
  const resources = new StandaloneRetentionResources(
    "postgres://invalid.test/disposable",
    () => {
      errors++;
      throw new Error("observer");
    },
  );
  assert.equal(resources.pool.options.max, 1);
  assert.equal(resources.pool.options.statement_timeout, 5000);
  assert.equal(resources.pool.options.connectionTimeoutMillis, 5000);
  assert.equal(resources.pool.totalCount, 0);
  resources.pool.emit("error", new Error("unavailable"));
  assert.equal(errors, 1);
  await resources.onApplicationShutdown();
  assert.equal(resources.pool.ended, true);
  assert.throws(() => new StandaloneRetentionResources("", () => {}));
});
