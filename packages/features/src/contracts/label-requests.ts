import { z } from "zod";
import {
  opaqueIdSchema,
  serviceIdSchema,
  environmentIdSchema,
} from "./identity.js";
import { incidentLabelInputSchema } from "./rule-label.js";
export const incidentLabelsQuerySchema = z.strictObject({
  serviceId: serviceIdSchema,
  environmentId: environmentIdSchema,
  stream: incidentLabelInputSchema.shape.stream.optional(),
  incidentId: opaqueIdSchema.optional(),
  status: z.enum(["draft", "reviewed"]).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  after: opaqueIdSchema.optional(),
});
export const incidentLabelIdSchema = z.strictObject({ id: opaqueIdSchema });
export const reviewIncidentLabelSchema = incidentLabelIdSchema.extend({
  expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});
export const editIncidentLabelSchema = reviewIncidentLabelSchema.extend({
  input: incidentLabelInputSchema,
});
export type IncidentLabelsQuery = z.input<typeof incidentLabelsQuerySchema>;
export type ReviewIncidentLabelInput = z.infer<
  typeof reviewIncidentLabelSchema
>;
export type EditIncidentLabelInput = z.infer<typeof editIncidentLabelSchema>;
