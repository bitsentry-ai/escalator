import { z } from "zod";
import {
  opaqueIdSchema,
  workspaceIdSchema,
  serviceIdSchema,
  environmentIdSchema,
} from "./identity.js";
import { utcTimestampSchema } from "./entities.js";
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const deploymentWatchProbeIntervalSeconds = 60;
/** One current owner per probe. Applied version, not the interval alone, fences restoration. */
export const watchCadenceLeaseSchema = z
  .strictObject({
    workspaceId: workspaceIdSchema,
    targetId: opaqueIdSchema,
    probeId: opaqueIdSchema,
    sourceId: opaqueIdSchema,
    serviceId: serviceIdSchema,
    environmentId: environmentIdSchema,
    generationId: opaqueIdSchema,
    generationDeploymentId: opaqueIdSchema,
    revision,
    originalIntervalSeconds: z.number().int().min(61).max(3600),
    appliedProbeVersion: revision.min(2),
    createdAt: utcTimestampSchema,
    restoreAt: utcTimestampSchema,
  })
  .refine(
    (value) => Date.parse(value.restoreAt) > Date.parse(value.createdAt),
    "Invalid cadence deadline",
  );
export const watchCadenceDecisionSchema = z.enum([
  "tightened",
  "joined",
  "already_fast",
  "disabled",
  "capacity_limited",
  "superseded",
  "expired",
]);
/** Immutable per-watch/probe receipt prevents a retried job overriding a later operator edit. */
export const watchCadenceReceiptSchema = z
  .strictObject({
    workspaceId: workspaceIdSchema,
    targetId: opaqueIdSchema,
    deploymentId: opaqueIdSchema,
    probeId: opaqueIdSchema,
    sourceId: opaqueIdSchema,
    serviceId: serviceIdSchema,
    environmentId: environmentIdSchema,
    recordedAt: utcTimestampSchema,
    decision: watchCadenceDecisionSchema,
    generationId: opaqueIdSchema.nullable(),
    appliedProbeVersion: revision.min(2).nullable(),
  })
  .refine(
    (value) =>
      ["tightened", "joined"].includes(value.decision)
        ? value.generationId !== null && value.appliedProbeVersion !== null
        : value.generationId === null && value.appliedProbeVersion === null,
    "Invalid cadence receipt ownership",
  );
export type WatchCadenceLease = z.infer<typeof watchCadenceLeaseSchema>;
export type WatchCadenceReceipt = z.infer<typeof watchCadenceReceiptSchema>;
