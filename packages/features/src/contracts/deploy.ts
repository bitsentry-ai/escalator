import { z } from "zod";
import {
  opaqueIdSchema,
  workspaceIdSchema,
  serviceIdSchema,
  environmentIdSchema,
  responderIdSchema,
} from "./identity.js";
import { utcTimestampSchema } from "./entities.js";
import { storableText, unicodeMessage } from "./text.js";

const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(storableText, unicodeMessage)
    .refine(
      (value) =>
        [...value].every(
          (character) =>
            character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
        ),
      "Control characters are not allowed",
    );
const timestamp = utcTimestampSchema.transform((value) =>
  new Date(value).toISOString(),
);
export const deploymentOutcomeSchema = z.enum([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
]);
export const deploymentStatusSchema = z.enum([
  "STARTED",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
]);
/** Deployment success never implies that the independent health watch passed. */
export const deploymentWatchVerdictSchema = z.enum([
  "PENDING",
  "PASS",
  "WARN",
  "FAIL",
  "INSUFFICIENT_DATA",
]);
const reference = {
  source: text(80),
  externalId: text(256),
  environmentId: environmentIdSchema,
};
export const deploymentStartInputSchema = z
  .strictObject({
    version: z.literal(1),
    ...reference,
    /** Display/provenance only. The authenticated grant supplies responder mapping. */
    actor: text(200),
    commit: text(200).nullable(),
    artifact: text(500).nullable(),
    occurredAt: timestamp,
    /** Optional for tracking-only callers; protected hooks must provide a current proof. */
    coverageDecisionId: opaqueIdSchema.optional(),
  })
  .refine(
    (value) => value.commit !== null || value.artifact !== null,
    "A commit or artifact is required",
  );
export const deploymentFinishInputSchema = z.strictObject({
  version: z.literal(1),
  ...reference,
  actor: text(200),
  occurredAt: timestamp,
  outcome: deploymentOutcomeSchema,
});
export const deploymentFinishSchema = z.strictObject({
  outcome: deploymentOutcomeSchema,
  actor: text(200),
  occurredAt: timestamp,
  receivedAt: timestamp,
});
/** A started deployment has neither finish nor timeout, a timed-out one has a timeout, and a finished one matches its finish. */
function statusMatchesState(
  status: string,
  finish: { outcome: string } | null,
  timedOutAt: string | null,
): boolean {
  if (status === "STARTED") return finish === null && timedOutAt === null;
  if (status === "TIMED_OUT") return timedOutAt !== null;
  return finish?.outcome === status && timedOutAt === null;
}
export const deploymentSchema = z
  .strictObject({
    id: opaqueIdSchema,
    workspaceId: workspaceIdSchema,
    serviceId: serviceIdSchema,
    ...reference,
    actor: text(200),
    commit: text(200).nullable(),
    artifact: text(500).nullable(),
    /** Immutable authentication/mapping snapshot, never taken from machine JSON. */
    tokenId: opaqueIdSchema,
    mappedDeployerId: responderIdSchema.nullable(),
    /** Immutable link to the proof enforced at first acceptance; absent on tracking-only starts. */
    coverageDecisionId: opaqueIdSchema.optional(),
    startedAt: timestamp,
    acceptedAt: timestamp,
    timeoutAt: timestamp,
    updatedAt: timestamp,
    status: deploymentStatusSchema,
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    timedOutAt: timestamp.nullable(),
    finish: deploymentFinishSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    const at = Date.parse;
    const finish = value.finish;
    const stateValid = statusMatchesState(
      value.status,
      finish,
      value.timedOutAt,
    );
    if (!stateValid || (value.commit === null && value.artifact === null))
      ctx.addIssue({ code: "custom", message: "Invalid deployment state" });
    if (
      at(value.startedAt) > at(value.acceptedAt) ||
      at(value.timeoutAt) <= at(value.startedAt) ||
      at(value.updatedAt) < at(value.acceptedAt) ||
      (value.timedOutAt !== null &&
        (at(value.timedOutAt) < at(value.timeoutAt) ||
          at(value.timedOutAt) < at(value.acceptedAt) ||
          at(value.timedOutAt) > at(value.updatedAt))) ||
      (finish !== null &&
        (at(finish.occurredAt) < at(value.startedAt) ||
          at(finish.occurredAt) > at(finish.receivedAt) ||
          at(finish.receivedAt) < at(value.acceptedAt) ||
          at(finish.receivedAt) > at(value.updatedAt) ||
          (value.timedOutAt !== null &&
            at(finish.receivedAt) < at(value.timedOutAt))))
    )
      ctx.addIssue({
        code: "custom",
        message: "Invalid deployment chronology",
      });
  });
export type Deployment = z.infer<typeof deploymentSchema>;
export type DeploymentStartInput = z.infer<typeof deploymentStartInputSchema>;
export type DeploymentFinishInput = z.infer<typeof deploymentFinishInputSchema>;
export type DeploymentOutcome = z.infer<typeof deploymentOutcomeSchema>;
export type DeploymentWatchVerdict = z.infer<
  typeof deploymentWatchVerdictSchema
>;
