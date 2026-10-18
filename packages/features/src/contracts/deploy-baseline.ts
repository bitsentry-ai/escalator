import { z } from "zod";
import {
  opaqueIdSchema,
  workspaceIdSchema,
  serviceIdSchema,
  environmentIdSchema,
} from "./identity.js";
import { utcTimestampSchema } from "./entities.js";
import {
  watchCriteriaSchema,
  watchEvidenceWindowSchema,
} from "./deploy-watch.js";

export const deploymentBaselinePinSeconds = 7 * 86400;

export const deploymentBaselineStreamSchema = z
  .strictObject({
    kind: z.enum(["probe", "metric"]),
    id: opaqueIdSchema,
    sourceId: opaqueIdSchema,
    configurationVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    /** Hash of the measurement definition, never the definition or credentials. */
    measurementHash: z.string().regex(/^[a-f0-9]{64}$/),
    criteria: watchCriteriaSchema,
    evidence: watchEvidenceWindowSchema,
  })
  .refine(
    (value) => value.kind === value.criteria.kind,
    "Watch criteria kind differs",
  );
/** Immutable actual evidence captured before acknowledging an accepted deployment start.
 * Overflow must be explicit; an incomplete source inventory can never establish PASS.
 */
export const deploymentBaselineSchema = z
  .strictObject({
    formatVersion: z.literal(1),
    workspaceId: workspaceIdSchema,
    targetId: opaqueIdSchema,
    deploymentId: opaqueIdSchema,
    serviceId: serviceIdSchema,
    environmentId: environmentIdSchema,
    startedAt: utcTimestampSchema,
    capturedAt: utcTimestampSchema,
    inventoryComplete: z.boolean(),
    streams: z.array(deploymentBaselineStreamSchema).max(128),
  })
  .superRefine((value, ctx) => {
    const keys = new Set<string>();
    const sources = new Set<string>();
    let receipts = 0,
      configurations = 0;
    for (const stream of value.streams) {
      const key = `${stream.kind}:${stream.id}`;
      if (keys.has(key))
        ctx.addIssue({ code: "custom", message: "Duplicate baseline stream" });
      keys.add(key);
      if (sources.has(stream.sourceId))
        ctx.addIssue({ code: "custom", message: "Duplicate baseline source" });
      sources.add(stream.sourceId);
      receipts += stream.evidence.samples.length;
      configurations += stream.evidence.segments.length;
    }
    if (
      receipts > 8192 ||
      configurations > 4096 ||
      JSON.stringify(value).length > 2000000
    )
      ctx.addIssue({
        code: "custom",
        message: "Baseline snapshot exceeds its bound",
      });
  });
export type DeploymentBaselineStream = z.infer<
  typeof deploymentBaselineStreamSchema
>;
export type DeploymentBaseline = z.infer<typeof deploymentBaselineSchema>;
