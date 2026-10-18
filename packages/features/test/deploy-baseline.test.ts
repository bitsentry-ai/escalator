import test from "node:test";
import assert from "node:assert/strict";
import {
  workspaceIdSchema,
  type DeploymentEntry,
  type DeploymentBaseline,
} from "../src/contracts/index.js";
import {
  baselineFromProjection,
  type BaselineProjection,
} from "../src/application/deploy/baseline-reader.js";
import {
  withDeploymentBaseline,
  type BaselineTransaction,
} from "../src/application/deploy/baseline.js";
import { withDeploymentTimeout } from "../src/application/deploy/stuck.js";
import { MemoryDeploymentRepository } from "./conformance/memory-deployments.js";
import {
  seedDeploymentFixture,
  fixtureDeployment,
} from "./conformance/deployments.js";
const scope = workspaceIdSchema.parse("baseline-a");
const other = workspaceIdSchema.parse("baseline-b");
function projection(
  entry: DeploymentEntry,
  kind: "probe" | "metric" = "probe",
): BaselineProjection {
  const owner = entry.deployment;
  const at = (seconds: number) =>
    new Date(Date.parse(owner.startedAt) + seconds * 1000).toISOString();
  return {
    workspaceId: owner.workspaceId,
    serviceId: owner.serviceId,
    environmentId: owner.environmentId,
    capturedAt: owner.acceptedAt,
    inventoryComplete: true,
    streams: [
      {
        workspaceId: owner.workspaceId,
        serviceId: owner.serviceId,
        environmentId: owner.environmentId,
        id: "api-check",
        sourceId: "source",
        configurationVersion: 1,
        measurementHash: "a".repeat(64),
        complete: true,
        configurations: [
          {
            version: 1,
            effectiveAt: at(-3600),
            recordedAt: at(-3600),
            enabled: true,
            anchorAt: at(-900),
            stepSeconds: 60,
            measurementHash: "a".repeat(64),
          },
        ],
        receipts: Array.from({ length: 15 }, (_, i) => ({
          id: `receipt-${i}`,
          version: 1,
          slotAt: at(-900 + i * 60),
          observedAt: at(-899 + i * 60),
          receivedAt: at(-898 + i * 60),
          usable: true,
          reading:
            kind === "probe"
              ? { kind: "probe" as const, state: "healthy" as const }
              : {
                  kind: "metric" as const,
                  quality: "complete" as const,
                  requests: 100,
                  errors: 2,
                },
        })),
        ...(kind === "probe"
          ? { kind, critical: false, failureThreshold: 3 }
          : {
              kind,
              rule: {
                windowSeconds: 300,
                minimumSamples: 3,
                minimumRequests: 100,
                errorRateFloor: 0.01,
              },
            }),
      },
    ],
  };
}
async function fixture(
  change?: (value: BaselineProjection) => void,
  failInsert = false,
) {
  let time = Date.parse("2026-10-04T00:00:00.000Z");
  const base = new MemoryDeploymentRepository({ now: () => new Date(time) });
  let captures = 0;
  const repository = {
    findTokenContext: base.findTokenContext.bind(base),
    transaction<T>(
      workspace: typeof scope,
      run: (tx: BaselineTransaction) => Promise<T>,
    ): Promise<T> {
      return base.withExtensions(
        workspace,
        (tx, _configuration, extensions, guard) => {
          const rows = (extensions.baselines ??= []) as DeploymentBaseline[];
          return run(
            withDeploymentTimeout(
              withDeploymentBaseline(
                tx,
                {
                  async capture(entry) {
                    captures++;
                    const value = projection(entry);
                    change?.(value);
                    return baselineFromProjection(entry, value);
                  },
                  async get(target, id) {
                    return structuredClone(
                      rows.find(
                        (row) =>
                          row.workspaceId === workspace &&
                          row.targetId === target &&
                          row.deploymentId === id,
                      ),
                    );
                  },
                  async insert(value) {
                    rows.push(structuredClone(value));
                    if (failInsert)
                      throw new Error("injected pin insert failure");
                  },
                },
                guard,
              ),
              guard,
            ),
          );
        },
      );
    },
  };
  const value = {
    repository,
    configuration: base.configuration,
    work: base.work,
    dispose: async () => {},
  };
  for (const workspace of [scope, other])
    await seedDeploymentFixture(value, workspace);
  return {
    ...value,
    base,
    captures: () => captures,
    advance: () => {
      time += 86400000;
    },
  };
}
async function entry() {
  const f = await fixture();
  return f.repository.transaction(scope, (tx) => fixtureDeployment(tx));
}
test("capture retains actual pre-deployment observations and explicit criteria", async () => {
  const deployment = await entry();
  for (const kind of ["probe", "metric"] as const) {
    const input = projection(deployment, kind);
    const captured = baselineFromProjection(deployment, input);
    assert.equal(captured.streams[0].evidence.samples.length, 15);
    assert.deepEqual(
      captured.streams[0].evidence.samples[0].reading,
      input.streams[0].receipts[0].reading,
    );
    assert.equal(captured.streams[0].criteria.kind, kind);
    input.streams[0].receipts[0].id = "changed";
    assert.equal(captured.streams[0].evidence.samples[0].id, "receipt-0");
  }
});
test("measurement changes and missing or truncated history remain explicit", async () => {
  const deployment = await entry();
  const input = projection(deployment);
  input.streams[0].measurementHash = "b".repeat(64);
  assert.equal(
    baselineFromProjection(deployment, input).streams[0].evidence
      .configurationCompatible,
    false,
  );
  input.streams[0].configurations[0].effectiveAt = null;
  input.streams[0].configurations[0].recordedAt = null;
  input.streams[0].complete = false;
  input.inventoryComplete = false;
  const value = baselineFromProjection(deployment, input);
  assert.deepEqual(value.streams[0].evidence.segments, []);
  assert.equal(value.streams[0].evidence.complete, false);
  assert.equal(value.inventoryComplete, false);
});
test("legacy unassigned receipts cannot fabricate scheduled observations", async () => {
  const deployment = await entry();
  const input = projection(deployment);
  input.streams[0].receipts[0].slotAt = null;
  input.streams[0].receipts[0].version = null;
  assert.equal(
    baselineFromProjection(deployment, input).streams[0].evidence.samples
      .length,
    14,
  );
});
test("foreign, future, duplicate and unbounded evidence is rejected", async () => {
  const deployment = await entry();
  const changes: ((v: BaselineProjection) => void)[] = [
    (v) => {
      v.workspaceId = other;
    },
    (v) => {
      v.streams[0].workspaceId = other;
    },
    (v) => {
      v.streams.push(structuredClone(v.streams[0]));
    },
    (v) => {
      v.streams[0].receipts.push(structuredClone(v.streams[0].receipts[0]));
    },
    (v) => {
      v.streams[0].receipts[0].receivedAt = new Date(
        Date.parse(v.capturedAt) + 1,
      ).toISOString();
    },
    (v) => {
      v.streams[0].receipts[0].slotAt = deployment.deployment.startedAt;
    },
    (v) => {
      v.streams[0].configurations.push(
        structuredClone(v.streams[0].configurations[0]),
      );
    },
    (v) => {
      v.streams[0].receipts = Array.from({ length: 129 }, () =>
        structuredClone(v.streams[0].receipts[0]),
      );
    },
  ];
  for (const change of changes) {
    const input = projection(deployment);
    change(input);
    assert.throws(() => baselineFromProjection(deployment, input));
  }
});
test("accepted start, baseline and timeout job share one rollback unit", async () => {
  const f = await fixture();
  await assert.rejects(
    f.repository.transaction(scope, async (tx) => {
      await tx.deployments.insert(await fixtureDeployment(tx));
      assert.equal(
        (await tx.baselines.get("target", "deployment"))?.streams.length,
        1,
      );
      throw new Error("abort caller");
    }),
    /abort caller/,
  );
  assert.equal(
    await f.repository.transaction(scope, (tx) =>
      tx.deployments.get("target", "deployment"),
    ),
    undefined,
  );
  f.advance();
  assert.equal(
    await f.work.claim({
      workspaceId: scope,
      queue: "job",
      token: "claim",
      leaseMs: 60000,
      kinds: ["deployment.timeout"],
    }),
    undefined,
  );
});
test("caught capture or pin errors still poison all prior writes", async () => {
  for (const f of [
    await fixture((v) => {
      v.streams[0].workspaceId = other;
    }),
    await fixture(undefined, true),
  ]) {
    await assert.rejects(
      f.repository.transaction(scope, async (tx) => {
        try {
          await tx.deployments.insert(await fixtureDeployment(tx));
        } catch {
          /* Deliberately caught. */
        }
      }),
    );
    assert.equal(
      await f.repository.transaction(scope, (tx) =>
        tx.deployments.get("target", "deployment"),
      ),
      undefined,
    );
  }
});
test("scoped snapshots stay immutable across retries and returned-object changes", async () => {
  const f = await fixture();
  for (const workspace of [scope, other])
    await f.repository.transaction(workspace, async (tx) =>
      tx.deployments.insert(await fixtureDeployment(tx)),
    );
  const a = (await f.repository.transaction(scope, (tx) =>
    tx.baselines.get("target", "deployment"),
  ))!;
  const b = (await f.repository.transaction(other, (tx) =>
    tx.baselines.get("target", "deployment"),
  ))!;
  assert.equal(a.workspaceId, scope);
  assert.equal(b.workspaceId, other);
  a.streams[0].evidence.samples[0].id = "mutated";
  await assert.rejects(
    f.repository.transaction(scope, async (tx) =>
      tx.deployments.insert(await fixtureDeployment(tx)),
    ),
  );
  assert.equal(f.captures(), 2);
  assert.equal(
    (await f.repository.transaction(scope, (tx) =>
      tx.baselines.get("target", "deployment"),
    ))!.streams[0].evidence.samples[0].id,
    "receipt-0",
  );
});
test("baseline handles cannot escape the guarded transaction lifetime", async () => {
  const f = await fixture();
  const read = await f.repository.transaction(scope, (tx) =>
    Promise.resolve(tx.baselines.get),
  );
  await assert.rejects(read("target", "deployment"));
});
