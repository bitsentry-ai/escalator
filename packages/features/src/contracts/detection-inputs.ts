import { z } from "zod";
import { serviceEnvironmentSchema } from "./alerts.js";
const fields = serviceEnvironmentSchema.shape;
export const detectionBindingKeySchema = z.strictObject({
  serviceId: fields.serviceId,
  environmentId: fields.environmentId,
});
export const writeDetectionBindingSchema = detectionBindingKeySchema
  .extend({
    expectedVersion: fields.version.nullable(),
    enabled: fields.enabled,
    policyId: fields.policyId,
  })
  .refine(
    (value) => !value.enabled || value.policyId !== null,
    "Enabled detection requires a policy",
  );
export type DetectionBindingKey = z.infer<typeof detectionBindingKeySchema>;
export type WriteDetectionBindingInput = z.infer<
  typeof writeDetectionBindingSchema
>;
