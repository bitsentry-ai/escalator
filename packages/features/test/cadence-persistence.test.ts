import test from "node:test";
import assert from "node:assert/strict";
import { workspaceIdSchema } from "../src/contracts/index.js";
import { fixture, scope } from "./conformance/watch-cadence-fixture.js";

test("cadence application is scoped, immutable and idempotent across fresh transactions", async () => {
  const f = await fixture(),
    first = await f.apply();
  f.time(60);
  assert.deepEqual(await f.apply(), first);
  await f.repo.transaction(scope, async (tx) => {
    assert.equal((await tx.probeContext.probes.get("probe"))?.version, 2);
    assert.equal(
      (await tx.cadence.lease(f.entry.targetId, "probe"))
        ?.originalIntervalSeconds,
      300,
    );
  });
  await assert.rejects(
    f.repo.transaction(workspaceIdSchema.parse("other"), (tx) =>
      tx.cadence.receipt(f.entry.targetId, f.entry.deployment.id, "probe"),
    ),
    /not_found/,
  );
});
test("caught cadence receipt failure rolls back the probe version and ownership lease", async () => {
  const f = await fixture();
  f.repo.failReceipt = true;
  await assert.rejects(f.apply(true), /Injected cadence/);
  await f.repo.transaction(scope, async (tx) => {
    assert.equal(
      (await tx.probeContext.probes.get("probe"))?.intervalSeconds,
      300,
    );
    assert.equal((await tx.probeContext.probes.get("probe"))?.version, 1);
    assert.equal(await tx.cadence.lease(f.entry.targetId, "probe"), undefined);
    assert.equal(
      await tx.cadence.receipt(
        f.entry.targetId,
        f.entry.deployment.id,
        "probe",
      ),
      undefined,
    );
  });
});
test("application receipt prevents replay from overriding a later operator edit", async () => {
  const f = await fixture(),
    first = await f.apply();
  f.time(10);
  await f.repo.transaction(scope, async (tx) => {
    await tx.probeContext.probes.lockCapacity();
    const current = (await tx.probeContext.probes.lock("probe"))!;
    assert.ok(
      await tx.probeContext.probes.put(
        {
          ...current,
          intervalSeconds: 600,
          version: current.version + 1,
          updatedAt: tx.now,
        },
        current.version,
      ),
    );
  });
  assert.deepEqual(await f.apply(), first);
  assert.equal(
    await f.repo.transaction(
      scope,
      async (tx) =>
        (await tx.probeContext.probes.get("probe"))!.intervalSeconds,
    ),
    600,
  );
});
test("stale cadence generation or revision cannot remove current ownership", async () => {
  const f = await fixture();
  await f.apply();
  await f.repo.transaction(scope, async (tx) => {
    const lease = (await tx.cadence.lease(f.entry.targetId, "probe"))!;
    assert.equal(
      await tx.cadence.removeLease(
        f.entry.targetId,
        "probe",
        "wrong-generation",
        lease.revision,
      ),
      false,
    );
    assert.equal(
      await tx.cadence.removeLease(
        f.entry.targetId,
        "probe",
        lease.generationId,
        lease.revision + 1,
      ),
      false,
    );
    assert.deepEqual(await tx.cadence.lease(f.entry.targetId, "probe"), lease);
  });
});

test("cadence composition preserves distinct deployment and signal token ports", async () => {
  const f = await fixture();
  await f.repo.transaction(scope, async (tx) => {
    const deploymentTokens = await tx.tokens.list(f.entry.targetId, {
      limit: 100,
    });
    assert.deepEqual(
      deploymentTokens.items.map((token) => token.id),
      ["token"],
    );
    const signalTokens = await tx.probeContext.tokens.list("probe-source", {
      limit: 100,
    });
    assert.deepEqual(signalTokens.items, []);
  });
});
