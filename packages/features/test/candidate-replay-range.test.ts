import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fixture, at } from "./conformance/rule-backtest-fixture.js";
import { ruleReplaySnapshotSchema } from "../src/contracts/rule-replay.js";
import { storedRuleReplaySnapshotSchema } from "../src/contracts/replay-run.js";
import { deriveCandidateReplay } from "../src/application/rules/candidate-replay.js";
test("shorter candidate lookbacks retain only what a capture of their range returns", () => {
  const base = fixture(),
    d = { ...base.version.definition, windowSeconds: 300 };
  const receipt = (minute: number) => ({
    version: 1,
    sample: {
      workspaceId: d.workspaceId,
      serviceId: d.serviceId,
      environmentId: d.environmentId,
      kind: "probe" as const,
      streamId: d.selector.streamId,
      id: `r-${minute}`,
      observedAt: at(minute),
      receivedAt: at(minute),
      slotAt: at(minute),
      usable: true,
      success: true,
      durationMs: 1,
    },
  });
  const fact = (id: string, minute: number, binding = false) => ({
    id,
    workspaceId: d.workspaceId,
    kind: binding ? ("binding" as const) : ("service" as const),
    entityId: binding ? "binding" : d.serviceId,
    serviceId: d.serviceId,
    environmentId: binding ? d.environmentId : null,
    sourceId: null,
    policyId: null,
    enabled: true,
    deleted: false,
    recordedAt: at(minute),
  });
  const snapshot = ruleReplaySnapshotSchema.parse({
    ...base,
    version: { ...base.version, definition: d },
    firstDecisionAt: at(5),
    samples: [],
    coverage: [],
    policies: [],
    complete: false,
    retained: {
      measurementHash: "a".repeat(64),
      policyFacts: [
        fact("1", -1),
        fact("4", 1, true),
        fact("2", 2),
        fact("3", 6),
      ],
      policyComplete: false,
      history: {
        workspaceId: d.workspaceId,
        serviceId: d.serviceId,
        environmentId: d.environmentId,
        kind: d.selector.kind,
        streamId: d.selector.streamId,
        snapshotAt: base.snapshotAt,
        visibleAt: base.snapshotAt,
        startAt: at(0),
        endAt: at(10),
        complete: false,
        configurations: [],
        receipts: Array.from({ length: 10 }, (_, i) => receipt(i + 1)),
      },
    },
  });
  const source = storedRuleReplaySnapshotSchema.parse({
    workspaceId: d.workspaceId,
    snapshot,
    inputHash: createHash("sha256")
      .update(JSON.stringify(snapshot))
      .digest("hex"),
  });
  const derive = (windowSeconds: number) =>
    deriveCandidateReplay(source, {
      ...snapshot.version,
      id: "new",
      definition: { ...d, windowSeconds },
    }).snapshot.retained!;
  const narrowed = derive(60);
  assert.equal(narrowed.history.startAt, at(4));
  assert.deepEqual(
    narrowed.history.receipts.map((r) => r.sample.id),
    ["r-5", "r-6", "r-7", "r-8", "r-9", "r-10"],
  );
  assert.deepEqual(
    narrowed.policyFacts.map((f) => f.id),
    ["4", "2", "3"],
  );
  const same = derive(300);
  assert.equal(same.history.receipts.length, 10);
  assert.deepEqual(same.policyFacts, snapshot.retained!.policyFacts);
});
