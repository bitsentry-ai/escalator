import { z } from "zod";
import {
  workspaceIdSchema,
  serviceIdSchema,
  environmentIdSchema,
  opaqueIdSchema,
} from "./identity.js";
import { utcTimestampSchema } from "./entities.js";
/** Append-only metadata, never provider configuration or credentials. Sequence IDs
 * disambiguate changes recorded within one timestamp; IDs are strings, not JS numbers.
 */
export const rulePolicyFactSchema = z
  .strictObject({
    id: z.string().regex(/^[1-9][0-9]{0,18}$/),
    workspaceId: workspaceIdSchema,
    kind: z.enum(["service", "binding", "policy", "signal", "probe", "metric"]),
    entityId: opaqueIdSchema,
    serviceId: serviceIdSchema,
    environmentId: environmentIdSchema.nullable(),
    sourceId: opaqueIdSchema.nullable(),
    policyId: opaqueIdSchema.nullable(),
    enabled: z.boolean(),
    deleted: z.boolean(),
    recordedAt: utcTimestampSchema,
  })
  .superRefine((row, context) => {
    if (
      (row.kind === "service" || row.kind === "policy") !==
      (row.environmentId === null)
    )
      context.addIssue({
        code: "custom",
        message: "Policy fact environment does not match its kind",
      });
    if (
      (row.kind === "probe" || row.kind === "metric") !==
      (row.sourceId !== null)
    )
      context.addIssue({
        code: "custom",
        message: "Only periodic stream facts carry a source binding",
      });
    if (row.kind !== "binding" && row.policyId !== null)
      context.addIssue({
        code: "custom",
        message: "Only detection binding facts carry a paging policy",
      });
    if (row.deleted && row.enabled)
      context.addIssue({
        code: "custom",
        message: "Deleted resources cannot remain enabled",
      });
  });
export type RulePolicyFact = z.infer<typeof rulePolicyFactSchema>;
