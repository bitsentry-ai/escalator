import { z } from "zod";
import { scheduleSchema, scheduleIdSchema } from "./schedule.js";
import {
  configuredContactSchema,
  configuredPolicySchema,
  availabilitySchema,
} from "./configuration.js";
import { opaqueIdSchema } from "./identity.js";
import { utcTimestampSchema } from "./entities.js";
const expectedVersion = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER - 1)
  .nullable();
export const writeScheduleSchema = scheduleSchema
  .omit({ workspaceId: true, version: true })
  .extend({ expectedVersion });
export const writeContactSchema = configuredContactSchema
  .omit({ workspaceId: true, version: true })
  .extend({ expectedVersion });
export const writeAvailabilitySchema = availabilitySchema
  .omit({ workspaceId: true, version: true })
  .extend({ expectedVersion });
// Reference field schemas once; the application/persistence layer revalidates the full policy.
const policy = configuredPolicySchema.shape;
export const writePolicySchema = z.strictObject({
  id: policy.id,
  serviceId: policy.serviceId,
  primaryScheduleId: policy.primaryScheduleId,
  peerScheduleId: policy.peerScheduleId,
  fallbackResponderIds: policy.fallbackResponderIds,
  steps: policy.steps,
  terminal: policy.terminal,
  enabled: policy.enabled,
  primaryPreviewId: policy.primaryPreviewId,
  peerPreviewId: policy.peerPreviewId,
  expectedVersion,
});
export const configurationPageSchema = z.strictObject({
  limit: z.number().int().min(1).max(50).default(25),
  after: opaqueIdSchema.optional(),
});
export const configurationIdSchema = z.strictObject({ id: opaqueIdSchema });
export const previewScheduleInputSchema = z.strictObject({
  scheduleId: scheduleIdSchema,
  startsAt: utcTimestampSchema,
  endsAt: utcTimestampSchema,
});
export type WriteScheduleInput = z.input<typeof writeScheduleSchema>;
export type WriteContactInput = z.input<typeof writeContactSchema>;
export type WriteAvailabilityInput = z.input<typeof writeAvailabilitySchema>;
export type WritePolicyInput = z.input<typeof writePolicySchema>;
export type ConfigurationPageInput = z.input<typeof configurationPageSchema>;
export type PreviewScheduleInput = z.input<typeof previewScheduleInputSchema>;
