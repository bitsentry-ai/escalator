import { createHash } from "node:crypto";
import {
  configuredPolicySchema,
  scheduleSchema,
  responderSchema,
  availabilitySchema,
  configuredContactSchema,
  utcTimestampSchema,
  hasCapability,
  deploymentCoverageBindingSchema,
  deploymentCoverageEvaluationSchema,
  type DeploymentCoverageBinding,
  type DeploymentCoverageEvaluation,
  type ConfiguredPolicy,
  type Schedule,
  type Responder,
  type Availability,
  type ConfiguredContact,
  type ResponderId,
} from "../../contracts/index.js";
import { resolveSchedule, isWorkingAt } from "../schedule/resolve.js";
/** Private evidence read in one host transaction. No contact secret is returned to the client. */
export interface DeploymentCoverageSnapshot {
  /** False for any bounded query overflow or missing evidence batch. */
  complete: boolean;
  policy: ConfiguredPolicy | null;
  schedules: Schedule[];
  responders: Responder[];
  availability: Availability[];
  contacts: ConfiguredContact[];
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
function ordered<T extends { id: string }>(rows: T[]): T[] {
  if (new Set(rows.map((row) => row.id)).size !== rows.length)
    throw new Error("Duplicate coverage evidence");
  return [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
/** Declared availability is not proof that a responder is awake or a channel will deliver. */
export function validateDeploymentCoverageSnapshot(
  raw: DeploymentCoverageSnapshot,
  binding: DeploymentCoverageBinding,
) {
  binding = deploymentCoverageBindingSchema.parse(binding);
  if (
    raw.schedules.length > 2 ||
    raw.responders.length > 103 ||
    raw.availability.length > 103 ||
    raw.contacts.length > 2060
  )
    throw new Error("Coverage evidence limit");
  const snapshot = {
    complete: raw.complete === true,
    policy:
      raw.policy === null ? null : configuredPolicySchema.parse(raw.policy),
    schedules: ordered(raw.schedules.map((row) => scheduleSchema.parse(row))),
    responders: ordered(
      raw.responders.map((row) => responderSchema.parse(row)),
    ),
    availability: ordered(
      raw.availability.map((row) => availabilitySchema.parse(row)),
    ),
    contacts: ordered(
      raw.contacts.map((row) => configuredContactSchema.parse(row)),
    ),
  };
  const all = [
    ...snapshot.schedules,
    ...snapshot.responders,
    ...snapshot.availability,
    ...snapshot.contacts,
    ...(snapshot.policy ? [snapshot.policy] : []),
  ];
  if (
    all.some((row) => row.workspaceId !== binding.workspaceId) ||
    snapshot.schedules.some((row) => row.serviceId !== binding.serviceId) ||
    (snapshot.policy &&
      (snapshot.policy.serviceId !== binding.serviceId ||
        snapshot.policy.id !== binding.policyId))
  )
    throw new Error("Coverage evidence scope mismatch");
  return snapshot;
}
export function evaluateDeploymentCoverage(
  raw: DeploymentCoverageSnapshot,
  binding: DeploymentCoverageBinding,
  at: string,
): DeploymentCoverageEvaluation {
  utcTimestampSchema.parse(at);
  binding = deploymentCoverageBindingSchema.parse(binding);
  const snapshot = validateDeploymentCoverageSnapshot(raw, binding);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(canonical({ binding, snapshot })))
    .digest("hex");
  const base = {
    fingerprint,
    policyVersion: snapshot.policy?.version ?? null,
    scheduleVersions: snapshot.schedules.map(({ id, version }) => ({
      id,
      version,
    })),
  };
  const block = (
    reason: DeploymentCoverageEvaluation["reason"],
  ): DeploymentCoverageEvaluation => ({
    ...base,
    decision: "block",
    reason,
    eligibleResponderIds: [],
  });
  const policy = snapshot.policy;
  if (!snapshot.complete || !policy?.enabled)
    return block("configuration_unavailable");
  const required = [
    ...new Set([policy.primaryScheduleId, policy.peerScheduleId]),
  ];
  if (
    required.some(
      (id) => !snapshot.schedules.find((row) => row.id === id)?.enabled,
    )
  )
    return block("configuration_unavailable");
  const deployer = snapshot.responders.find(
    (row) => row.id === binding.mappedDeployerId,
  );
  if (
    !deployer?.enabled ||
    !hasCapability(deployer.role, "incident:acknowledge")
  )
    return block("unmapped_deployer");
  const candidates = new Set<ResponderId>(policy.fallbackResponderIds);
  for (const id of required) {
    const assignment = resolveSchedule(
      snapshot.schedules.find((row) => row.id === id),
      at,
    );
    if (assignment) candidates.add(assignment.responderId);
  }
  candidates.delete(deployer.id);
  const eligibleResponderIds = [...candidates]
    .filter((id) => {
      const responder = snapshot.responders.find((row) => row.id === id);
      const hours = snapshot.availability.find((row) => row.id === id);
      return (
        responder?.enabled &&
        hasCapability(responder.role, "incident:acknowledge") &&
        hours &&
        isWorkingAt(
          { responderId: id, timeZone: hours.timeZone, windows: hours.windows },
          at,
        ) &&
        snapshot.contacts.some((row) => row.responderId === id && row.enabled)
      );
    })
    .sort();
  return deploymentCoverageEvaluationSchema.parse(
    eligibleResponderIds.length
      ? {
          ...base,
          decision: "allow",
          reason: "declared_coverage",
          eligibleResponderIds,
        }
      : block("no_declared_coverage"),
  );
}
