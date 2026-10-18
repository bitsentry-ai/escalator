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

const content = {
  serviceId: serviceIdSchema,
  environmentId: environmentIdSchema,
  stream: z.strictObject({
    kind: z.enum(["metric", "probe", "signal"]),
    id: opaqueIdSchema,
  }),
  origin: z.enum(["incident_review", "missed_incident"]),
  incidentId: opaqueIdSchema.nullable(),
  outcome: z.enum(["actionable", "noise"]),
  startedAt: utcTimestampSchema,
  endedAt: utcTimestampSchema,
  summary: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .refine(storableText, unicodeMessage),
};
type LabelContent = {
  origin: string;
  incidentId: string | null;
  outcome: string;
  startedAt: string;
  endedAt: string;
};
function validateContent(value: LabelContent, context: z.RefinementCtx): void {
  const duration = Date.parse(value.endedAt) - Date.parse(value.startedAt);
  if (duration <= 0 || duration > 31 * 86400000)
    context.addIssue({
      code: "custom",
      message: "Label interval must span at most 31 days",
    });
  if ((value.origin === "incident_review") !== (value.incidentId !== null))
    context.addIssue({
      code: "custom",
      message:
        "Incident review requires a linked incident; missed incidents are unlinked",
    });
  if (value.origin === "missed_incident" && value.outcome !== "actionable")
    context.addIssue({
      code: "custom",
      message: "A missed incident is an actionable event, not a noise label",
    });
}
/** Trusted actor scope and review fields are deliberately absent from input. */
export const incidentLabelInputSchema = z
  .strictObject(content)
  .superRefine(validateContent);
export type IncidentLabelInput = z.infer<typeof incidentLabelInputSchema>;
export const incidentLabelSchema = z
  .strictObject({
    ...content,
    id: opaqueIdSchema,
    workspaceId: workspaceIdSchema,
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    status: z.enum(["draft", "reviewed"]),
    createdBy: responderIdSchema,
    createdAt: utcTimestampSchema,
    updatedAt: utcTimestampSchema,
    reviewedBy: responderIdSchema.nullable(),
    reviewedAt: utcTimestampSchema.nullable(),
  })
  .superRefine((value, context) => {
    validateContent(value, context);
    const reviewed = value.status === "reviewed";
    if (
      reviewed !== (value.reviewedBy !== null) ||
      reviewed !== (value.reviewedAt !== null)
    )
      context.addIssue({
        code: "custom",
        message: "Reviewed labels require human attribution and review time",
      });
    if (
      Date.parse(value.endedAt) > Date.parse(value.updatedAt) ||
      Date.parse(value.updatedAt) < Date.parse(value.createdAt) ||
      (value.reviewedAt !== null && value.reviewedAt !== value.updatedAt)
    )
      context.addIssue({
        code: "custom",
        message: "Label history has inconsistent timestamps",
      });
  });
export type IncidentLabel = z.infer<typeof incidentLabelSchema>;
