import { ruleReplaySnapshotSchema } from "../../src/contracts/rule-replay.js";
import { rulePolicyFactSchema } from "../../src/contracts/rule-policy.js";
export const at = (minute: number) =>
  new Date(Date.parse("2026-10-07T00:00:00Z") + minute * 60000).toISOString();
const scope = { workspaceId: "org", serviceId: "api", environmentId: "prod" },
  hash = "a".repeat(64);
export function fixture() {
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
