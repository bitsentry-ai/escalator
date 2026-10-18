import test from "node:test";
import assert from "node:assert/strict";
import { coverageFixture } from "./conformance/coverage-fixture.js";
import { deploymentTargetSchema } from "../src/contracts/index.js";
import { coverageDecision } from "../src/domain/deploy/coverage-decision.js";
import { evaluateDeploymentCoverage } from "../src/domain/deploy/coverage.js";
import { coverageTransaction } from "../src/application/deploy/coverage-transaction.js";
import { TransactionGuard } from "../src/application/ports/transaction-guard.js";
import type { DeploymentTransaction } from "../src/application/deploy/ports.js";
import type {
  CoverageRecord,
  CoverageRecordStore,
} from "../src/application/deploy/coverage-ports.js";
const now = "2026-10-05T12:00:00.000Z";
function fixture() {
  const { binding, snapshot } = coverageFixture();
  const owner = deploymentTargetSchema.parse({
    id: binding.targetId,
    workspaceId: binding.workspaceId,
    serviceId: binding.serviceId,
    environmentId: binding.environmentId,
    name: "API",
    enabled: true,
    revision: 1,
    timeoutSeconds: 600,
    policyId: "policy",
    createdAt: now,
    updatedAt: now,
  });
  const rows: CoverageRecord[] = [];
  let reads = 0;
  const requested: unknown[] = [];
  const store: CoverageRecordStore = {
    snapshot: async (_target, mapped) => {
      requested.push(mapped);
      reads++;
      return snapshot;
    },
    get: async (_, id) => rows.find((row) => row.decision.id === id),
    find: async (_, key) => rows.find((row) => row.key === key),
    insert: async (value) => {
      rows.push(structuredClone(value));
    },
  };
  const base = {
    workspaceId: binding.workspaceId,
    now,
    currentTime: async () => now,
    targets: {
      get: async (id: string) => (id === owner.id ? owner : undefined),
    },
    responders: {
      get: async (id: string) =>
        snapshot.responders.find((row) => row.id === id),
    },
  } as unknown as DeploymentTransaction;
  const guard = new TransactionGuard();
  const tx = coverageTransaction(base, store, guard);
  const evaluation = evaluateDeploymentCoverage(snapshot, binding, now);
  const record: CoverageRecord = {
    key: "preflight-1",
    requestHash: "a".repeat(64),
    decision: coverageDecision({ id: "decision", binding, evaluation, now }),
  };
  return {
    binding,
    snapshot,
    owner,
    rows,
    store,
    guard,
    tx,
    record,
    reads: () => reads,
    requested,
  };
}
test("coverage persistence uses one captured snapshot and returns defensive copies", async () => {
  const f = fixture();
  const first = await f.tx.coverage.snapshot(
    "target",
    f.binding.mappedDeployerId,
  );
  first.responders[0]!.enabled = false;
  assert.equal(
    (await f.tx.coverage.snapshot("target", f.binding.mappedDeployerId))
      .responders[0]!.enabled,
    true,
  );
  f.snapshot.responders[0]!.enabled = false;
  await f.tx.coverage.insert(f.record);
  assert.equal(f.reads(), 1);
  assert.deepEqual(f.requested, [f.binding.mappedDeployerId]);
  assert.equal(f.rows.length, 1);
  assert.deepEqual(await f.tx.coverage.get("target", "decision"), f.record);
  const returned = (await f.tx.coverage.find("target", "preflight-1"))!;
  returned.decision.binding.externalId = "changed";
  assert.equal(f.rows[0]!.decision.binding.externalId, "42");
  f.guard.close();
  await assert.rejects(f.tx.coverage.get("target", "decision"), {
    code: "closed_transaction",
  });
});
test("forged evaluation, stale revision and future timestamps poison coverage writes", async () => {
  for (const mutate of [
    (r: CoverageRecord) => {
      r.decision.evaluation.fingerprint = "b".repeat(64);
    },
    (r: CoverageRecord) => {
      r.decision.binding.targetRevision = 2;
    },
    (r: CoverageRecord) => {
      r.decision.evaluatedAt = "2026-10-05T12:00:01.000Z";
    },
  ]) {
    const f = fixture();
    mutate(f.record);
    await assert.rejects(f.tx.coverage.insert(f.record));
    assert.throws(() => f.guard.assertCommittable());
    assert.equal(f.rows.length, 0);
  }
});
test("foreign or misprojected records are rejected and cannot be committed after catching the error", async () => {
  for (const mode of ["scope", "id", "key"] as const) {
    const f = fixture();
    await f.tx.coverage.insert(f.record);
    if (mode === "scope")
      f.rows[0]!.decision.binding.workspaceId =
        "other" as typeof f.binding.workspaceId;
    if (mode === "id")
      f.store.get = async () => ({
        ...f.record,
        decision: { ...f.record.decision, id: "other" },
      });
    if (mode === "key")
      f.store.find = async () => ({ ...f.record, key: "other" });
    await assert.rejects(
      mode === "key"
        ? f.tx.coverage.find("target", "preflight-1")
        : f.tx.coverage.get("target", "decision"),
    );
    assert.throws(() => f.guard.assertCommittable());
  }
  const f = fixture();
  f.snapshot.contacts[0]!.workspaceId = "other" as typeof f.binding.workspaceId;
  await assert.rejects(
    f.tx.coverage.snapshot("target", f.binding.mappedDeployerId),
    /scope mismatch/,
  );
  assert.throws(() => f.guard.assertCommittable());
});
test("an override cannot be persisted after its actor is disabled or loses the required role", async () => {
  for (const mode of ["disabled", "role"] as const) {
    const f = fixture();
    f.snapshot.responders[0]!.role = "administrator";
    f.record.decision = coverageDecision({
      id: "decision",
      binding: f.binding,
      evaluation: evaluateDeploymentCoverage(f.snapshot, f.binding, now),
      now,
      override: {
        actor: {
          workspaceId: f.binding.workspaceId,
          responderId: f.snapshot.responders[0]!.id,
          role: "administrator",
        },
        reason: "urgent repair",
      },
    });
    await f.tx.coverage.snapshot("target", f.binding.mappedDeployerId);
    if (mode === "disabled") f.snapshot.responders[0]!.enabled = false;
    else f.snapshot.responders[0]!.role = "responder";
    await assert.rejects(f.tx.coverage.insert(f.record), { code: "forbidden" });
    assert.equal(f.rows.length, 0);
  }
});
