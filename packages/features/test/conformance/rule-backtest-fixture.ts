import { ruleReplaySnapshotSchema } from "../../src/contracts/rule-replay.js";
import { incidentLabelSchema } from "../../src/contracts/rule-label.js";
export const at = (minute: number) =>
  new Date(Date.parse("2026-10-07T00:00:00Z") + minute * 60000).toISOString();
const scope = { workspaceId: "org", serviceId: "api", environmentId: "prod" };
export function fixture() {
  return ruleReplaySnapshotSchema.parse({
    snapshotId: "snapshot",
    snapshotAt: at(20),
    firstDecisionAt: at(1),
    lastDecisionAt: at(10),
    complete: true,
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
        minimumSamples: 1,
        trigger: { operator: "gte", value: 1 },
        recovery: { operator: "lt", value: 1 },
        persistenceSeconds: 0,
        recoverySeconds: 0,
        cooldownSeconds: 0,
        severity: "high",
      },
    },
    samples: Array.from({ length: 10 }, (_, i) => ({
      ...scope,
      kind: "probe",
      streamId: "probe",
      id: `s-${i}`,
      observedAt: at(i + 1),
      receivedAt: at(i + 1),
      usable: true,
      success: i !== 1 && i !== 4,
      durationMs: 1,
    })),
    coverage: [
      { startAt: at(0), endAt: at(11), recordedAt: at(0), state: "complete" },
    ],
    policies: [
      {
        startAt: at(0),
        endAt: at(11),
        recordedAt: at(0),
        enabled: true,
        maintenance: false,
      },
    ],
  });
}
export function label(
  id: string,
  from: number,
  to: number,
  outcome: "actionable" | "noise" = "actionable",
) {
  return incidentLabelSchema.parse({
    ...scope,
    id,
    revision: 1,
    status: "reviewed",
    stream: { kind: "probe", id: "probe" },
    origin: "incident_review",
    incidentId: `incident-${id}`,
    outcome,
    startedAt: at(from),
    endedAt: at(to),
    summary: "Reviewed event",
    createdBy: "operator",
    createdAt: at(11),
    updatedAt: at(12),
    reviewedBy: "operator",
    reviewedAt: at(12),
  });
}
