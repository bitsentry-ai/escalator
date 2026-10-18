import test from "node:test";
import assert from "node:assert/strict";
import { ruleReplaySnapshotSchema } from "../src/contracts/rule-replay.js";
import { ruleHistorySnapshotSchema } from "../src/contracts/rule-history.js";
import { rulePolicyFactSchema } from "../src/contracts/rule-policy.js";
import type {
  RuleEvaluationState,
  RuleTransition,
} from "../src/contracts/rule-state.js";
import { replayRuleWindows } from "../src/application/rules/replay.js";
import { readRuleHistoryWindow } from "../src/application/rules/history-reader.js";
import { resolveRulePolicy } from "../src/application/rules/policy.js";
import { advanceRuleDecision } from "../src/domain/rules/advance.js";
import {
  encodeRuleReplayData,
  decodeRuleReplaySnapshot,
} from "../src/application/rules/replay-storage-codec.js";
const at = (minute: number) =>
  new Date(Date.parse("2026-10-07T00:00:00Z") + minute * 60000).toISOString();
const scope = { workspaceId: "org", serviceId: "api", environmentId: "prod" },
  hash = "a".repeat(64);
function fixture() {
  const facts = [
    {
      id: "1",
      kind: "service",
      entityId: "api",
      environmentId: null,
      sourceId: null,
      policyId: null,
    },
    {
      id: "2",
      kind: "signal",
      entityId: "source",
      environmentId: "prod",
      sourceId: null,
      policyId: null,
    },
    {
      id: "3",
      kind: "probe",
      entityId: "probe",
      environmentId: "prod",
      sourceId: "source",
      policyId: null,
    },
    {
      id: "4",
      kind: "binding",
      entityId: "binding",
      environmentId: "prod",
      sourceId: null,
      policyId: "policy",
    },
    {
      id: "5",
      kind: "policy",
      entityId: "policy",
      environmentId: null,
      sourceId: null,
      policyId: null,
    },
  ].map((f) =>
    rulePolicyFactSchema.parse({
      ...scope,
      ...f,
      enabled: true,
      deleted: false,
      recordedAt: at(0),
    }),
  );
  return ruleReplaySnapshotSchema.parse({
    snapshotId: "snapshot",
    snapshotAt: at(7),
    firstDecisionAt: at(3),
    lastDecisionAt: at(6),
    complete: true,
    samples: [],
    coverage: [],
    policies: [],
    version: {
      id: "rule",
      revision: 1,
      definition: {
        ...scope,
        languageVersion: 1,
        selector: { kind: "probe", streamId: "probe", field: "failure" },
        aggregation: "maximum",
        windowSeconds: 60,
        stepSeconds: 60,
        collectionDelaySeconds: 60,
        minimumSamples: 1,
        trigger: { operator: "gte", value: 1 },
        recovery: { operator: "lt", value: 1 },
        persistenceSeconds: 0,
        recoverySeconds: 0,
        cooldownSeconds: 0,
        severity: "high",
      },
    },
    retained: {
      measurementHash: hash,
      policyFacts: facts,
      policyComplete: true,
      history: {
        ...scope,
        kind: "probe",
        streamId: "probe",
        snapshotAt: at(7),
        startAt: at(1),
        endAt: at(5),
        visibleAt: at(7),
        complete: true,
        configurations: [
          {
            version: 1,
            effectiveAt: at(0),
            recordedAt: at(0),
            enabled: true,
            anchorAt: at(0),
            stepSeconds: 60,
            measurementHash: hash,
          },
        ],
        receipts: [2, 3, 4, 5].map((m) => ({
          version: 1,
          sample: {
            ...scope,
            id: `sample-${m}`,
            kind: "probe",
            streamId: "probe",
            slotAt: at(m),
            observedAt: at(m + 0.1),
            receivedAt: at(m + 0.2),
            usable: true,
            success: m >= 4,
            durationMs: 6000,
          },
        })),
      },
    },
  });
}
const budget = { maxDecisions: 60, maxSampleVisits: 100000 };
test("captured retained history uses the live coverage and policy projection", async () => {
  const snapshot = fixture(),
    retained = snapshot.retained!,
    rule = snapshot.version.definition;
  let state: RuleEvaluationState | null = null;
  const live: RuleTransition[] = [];
  for (const minute of [3, 4, 5, 6]) {
    const window = await readRuleHistoryWindow(
      {
        snapshot: async (_scope, query) =>
          ruleHistorySnapshotSchema.parse({
            ...retained.history,
            ...query,
            receipts: retained.history.receipts.filter(
              (r) =>
                r.sample.kind !== "signal" &&
                Date.parse(r.sample.slotAt!) > Date.parse(query.startAt) &&
                Date.parse(r.sample.slotAt!) <= Date.parse(query.endAt),
            ),
          }),
      },
      rule,
      at(minute),
      hash,
    );
    const policy = resolveRulePolicy(rule, at(minute), retained.policyFacts);
    const decision = advanceRuleDecision(snapshot.version, state, {
      window,
      enabled: policy.enabled,
      maintenance: policy.maintenance,
    });
    live.push(decision);
    state = decision.state;
  }
  const result = replayRuleWindows(snapshot, null, budget);
  assert.deepEqual(result.decisions, live);
  assert.deepEqual(
    result.decisions.map((d) => d.action),
    ["opened", "none", "recovered", "none"],
  );
  const first = replayRuleWindows(snapshot, null, {
    ...budget,
    maxDecisions: 2,
  });
  assert.deepEqual(
    [
      ...first.decisions,
      ...replayRuleWindows(snapshot, first.cursor, budget).decisions,
    ],
    live,
  );
});
test("a receipt a microsecond after the decision is unavailable to replay", () => {
  const snapshot = fixture();
  snapshot.retained!.history.receipts[0]!.sample.receivedAt =
    "2026-10-07T00:03:00.000001Z";
  const result = replayRuleWindows(snapshot, null, budget);
  assert.equal(result.decisions[0]!.action, "none");
  assert.equal(result.decisions[1]!.action, "opened");
});
test("a future policy disable cannot retroactively suppress an earlier opening", () => {
  const snapshot = fixture();
  snapshot.retained!.policyFacts.push(
    rulePolicyFactSchema.parse({
      ...snapshot.retained!.policyFacts[0],
      id: "6",
      enabled: false,
      recordedAt: "2026-10-07T00:03:00.000001Z",
    }),
  );
  const result = replayRuleWindows(snapshot, null, budget);
  assert.equal(result.decisions[0]!.action, "opened");
  assert.equal(result.decisions[1]!.status, "suppressed");
});
test("missing or bounded policy history stays unknown", () => {
  for (const bounded of [false, true]) {
    const snapshot = fixture();
    snapshot.retained!.policyFacts = [];
    if (bounded) {
      snapshot.retained!.policyComplete = false;
      snapshot.complete = false;
    }
    assert.ok(
      replayRuleWindows(snapshot, null, budget).decisions.every(
        (d) => d.verdict?.state === "insufficient_data",
      ),
    );
  }
});
test("a retained snapshot round-trips without persisting a competing tenant field", () => {
  const snapshot = fixture(),
    workspaceId = snapshot.version.definition.workspaceId;
  const stored = { workspaceId, snapshot, inputHash: hash };
  const encoded = encodeRuleReplayData(workspaceId, "snapshot", stored);
  assert.equal(encoded.includes("workspaceId"), false);
  assert.deepEqual(
    decodeRuleReplaySnapshot(workspaceId, JSON.parse(encoded)),
    stored,
  );
});
test("receipt scopes and future availability are rejected before evaluation", () => {
  const raw = JSON.parse(JSON.stringify(fixture()));
  raw.retained.history.receipts[0].sample.workspaceId = "other";
  assert.throws(() => ruleReplaySnapshotSchema.parse(raw), /Retained replay/);
  const future = fixture();
  future.retained!.history.receipts[0]!.sample.receivedAt = at(8);
  assert.throws(
    () => ruleReplaySnapshotSchema.parse(future),
    /Retained replay/,
  );
});
