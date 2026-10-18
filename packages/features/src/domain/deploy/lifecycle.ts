import { z } from "zod";
import {
  deploymentSchema,
  deploymentStartInputSchema,
  deploymentFinishInputSchema,
  opaqueIdSchema,
  workspaceIdSchema,
  serviceIdSchema,
  environmentIdSchema,
  responderIdSchema,
  utcTimestampSchema,
  type Deployment,
  type DeploymentStartInput,
  type DeploymentFinishInput,
} from "../../contracts/index.js";

export const deploymentStartContextSchema = z.strictObject({
  id: opaqueIdSchema,
  workspaceId: workspaceIdSchema,
  serviceId: serviceIdSchema,
  environmentId: environmentIdSchema,
  tokenId: opaqueIdSchema,
  mappedDeployerId: responderIdSchema.nullable(),
  /** Trusted service policy, not a caller-selected deadline. */
  timeoutSeconds: z.number().int().min(60).max(86400),
});
export type DeploymentStartContext = z.infer<
  typeof deploymentStartContextSchema
>;
export type DeploymentTransition =
  | { state: "changed"; deployment: Deployment }
  | { state: "unchanged"; reason: "duplicate" | "terminal" }
  | { state: "wait"; dueAt: string }
  | {
      state: "rejected";
      reason:
        | "scope"
        | "identity"
        | "conflict"
        | "missing_start"
        | "chronology";
    };
function now(value: string): string {
  return new Date(utcTimestampSchema.parse(value)).toISOString();
}
function revision(current: Deployment): number {
  if (current.revision === Number.MAX_SAFE_INTEGER)
    throw new RangeError("Deployment revision exhausted");
  return current.revision + 1;
}
/** Pure decisions only. The caller locks the record and commits state, event receipt,
 * deadline and audit atomically. Authentication must run even on duplicate requests.
 */
export function startDeployment(
  current: Deployment | undefined,
  raw: DeploymentStartInput,
  rawContext: DeploymentStartContext,
  databaseNow: string,
): DeploymentTransition {
  const input = deploymentStartInputSchema.parse(raw);
  const context = deploymentStartContextSchema.parse(rawContext);
  const at = now(databaseNow);
  if (input.environmentId !== context.environmentId)
    return { state: "rejected", reason: "scope" };
  if (current) {
    current = deploymentSchema.parse(current);
    if (
      current.workspaceId !== context.workspaceId ||
      current.serviceId !== context.serviceId ||
      current.environmentId !== context.environmentId
    )
      return { state: "rejected", reason: "scope" };
    if (
      current.id !== context.id ||
      current.source !== input.source ||
      current.externalId !== input.externalId
    )
      return { state: "rejected", reason: "identity" };
    // Rotation or policy changes do not rewrite the original grant/mapping/deadline.
    return current.actor === input.actor &&
      current.commit === input.commit &&
      current.artifact === input.artifact &&
      current.startedAt === input.occurredAt &&
      (input.coverageDecisionId === undefined ||
        input.coverageDecisionId === current.coverageDecisionId)
      ? { state: "unchanged", reason: "duplicate" }
      : { state: "rejected", reason: "conflict" };
  }
  if (Date.parse(input.occurredAt) > Date.parse(at))
    return { state: "rejected", reason: "chronology" };
  return {
    state: "changed",
    deployment: deploymentSchema.parse({
      id: context.id,
      workspaceId: context.workspaceId,
      serviceId: context.serviceId,
      environmentId: context.environmentId,
      source: input.source,
      externalId: input.externalId,
      actor: input.actor,
      commit: input.commit,
      artifact: input.artifact,
      tokenId: context.tokenId,
      mappedDeployerId: context.mappedDeployerId,
      ...(input.coverageDecisionId === undefined
        ? {}
        : { coverageDecisionId: input.coverageDecisionId }),
      startedAt: input.occurredAt,
      acceptedAt: at,
      timeoutAt: new Date(
        Date.parse(input.occurredAt) + context.timeoutSeconds * 1000,
      ).toISOString(),
      updatedAt: at,
      status: "STARTED",
      revision: 1,
      timedOutAt: null,
      finish: null,
    }),
  };
}
export function finishDeployment(
  current: Deployment | undefined,
  raw: DeploymentFinishInput,
  databaseNow: string,
): DeploymentTransition {
  const input = deploymentFinishInputSchema.parse(raw);
  const at = now(databaseNow);
  if (!current) return { state: "rejected", reason: "missing_start" };
  current = deploymentSchema.parse(current);
  if (current.environmentId !== input.environmentId)
    return { state: "rejected", reason: "scope" };
  if (
    current.source !== input.source ||
    current.externalId !== input.externalId
  )
    return { state: "rejected", reason: "identity" };
  if (current.finish) {
    return current.finish.actor === input.actor &&
      current.finish.outcome === input.outcome &&
      current.finish.occurredAt === input.occurredAt
      ? { state: "unchanged", reason: "duplicate" }
      : { state: "rejected", reason: "conflict" };
  }
  if (
    Date.parse(input.occurredAt) < Date.parse(current.startedAt) ||
    Date.parse(input.occurredAt) > Date.parse(at) ||
    Date.parse(at) < Date.parse(current.updatedAt)
  )
    return { state: "rejected", reason: "chronology" };
  return {
    state: "changed",
    deployment: deploymentSchema.parse({
      ...current,
      status: current.status === "TIMED_OUT" ? "TIMED_OUT" : input.outcome,
      updatedAt: at,
      revision: revision(current),
      finish: {
        outcome: input.outcome,
        actor: input.actor,
        occurredAt: input.occurredAt,
        receivedAt: at,
      },
    }),
  };
}
/** A timeout fences only an unfinished deployment. A late finish adds evidence;
 * it cannot undo this state or erase the already-created stuck-deploy page.
 */
export function timeoutDeployment(
  current: Deployment,
  databaseNow: string,
): DeploymentTransition {
  current = deploymentSchema.parse(current);
  const at = now(databaseNow);
  if (current.status !== "STARTED")
    return { state: "unchanged", reason: "terminal" };
  if (Date.parse(at) < Date.parse(current.updatedAt))
    return { state: "rejected", reason: "chronology" };
  if (Date.parse(at) < Date.parse(current.timeoutAt))
    return { state: "wait", dueAt: current.timeoutAt };
  return {
    state: "changed",
    deployment: deploymentSchema.parse({
      ...current,
      status: "TIMED_OUT",
      updatedAt: at,
      timedOutAt: at,
      revision: revision(current),
    }),
  };
}
