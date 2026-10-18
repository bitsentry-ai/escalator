import { createHash } from "node:crypto";
import { fixture, at } from "./rule-backtest-fixture.js";
import { ruleReplaySnapshotSchema } from "../../src/contracts/rule-replay.js";
import { storedRuleReplaySnapshotSchema } from "../../src/contracts/replay-run.js";
export function proposalCapture() {
  const old = fixture(),
    d = old.version.definition;
  const snapshot = ruleReplaySnapshotSchema.parse({
    ...old,
    samples: [],
    coverage: [],
    policies: [],
    complete: false,
    retained: {
      measurementHash: "a".repeat(64),
      policyFacts: [],
      policyComplete: false,
      history: {
        workspaceId: d.workspaceId,
        serviceId: d.serviceId,
        environmentId: d.environmentId,
        kind: d.selector.kind,
        streamId: d.selector.streamId,
        snapshotAt: old.snapshotAt,
        visibleAt: old.snapshotAt,
        startAt: at(0),
        endAt: at(10),
        complete: false,
        configurations: [],
        receipts: [],
      },
    },
  });
  return storedRuleReplaySnapshotSchema.parse({
    workspaceId: d.workspaceId,
    snapshot,
    inputHash: createHash("sha256")
      .update(JSON.stringify(snapshot))
      .digest("hex"),
  });
}
