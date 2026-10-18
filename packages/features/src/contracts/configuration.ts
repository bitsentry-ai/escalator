import { z } from "zod";
import {
  opaqueIdSchema,
  responderIdSchema,
  workspaceIdSchema,
  serviceIdSchema,
} from "./identity.js";
import { utcTimestampSchema } from "./entities.js";
import { scheduleIdSchema, workingHoursSchema } from "./schedule.js";
import { escalationPolicySchema } from "./escalation.js";
import { pagingContactSchema } from "./contact.js";
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const configuredContactSchema = pagingContactSchema.extend({ version });
export type ConfiguredContact = z.infer<typeof configuredContactSchema>;
export const configuredPolicySchema = escalationPolicySchema
  .safeExtend({
    enabled: z.boolean(),
    primaryPreviewId: opaqueIdSchema.nullable(),
    peerPreviewId: opaqueIdSchema.nullable(),
  })
  .refine(
    (value) =>
      !value.enabled ||
      (value.primaryPreviewId !== null && value.peerPreviewId !== null),
    "Enabled policies require reviewed previews",
  );
export const availabilitySchema = workingHoursSchema
  .omit({ responderId: true })
  .extend({
    id: responderIdSchema,
    workspaceId: workspaceIdSchema,
    version,
  });
const assignmentSchema = z.strictObject({
  responderId: responderIdSchema,
  source: z.enum(["rotation", "override"]),
  sourceId: opaqueIdSchema,
  startsAt: utcTimestampSchema,
  endsAt: utcTimestampSchema,
});
const previewIntervalSchema = z.strictObject({
  startsAt: utcTimestampSchema,
  endsAt: utcTimestampSchema,
  assignment: assignmentSchema.nullable(),
});
export const schedulePreviewSchema = z
  .strictObject({
    id: opaqueIdSchema,
    workspaceId: workspaceIdSchema,
    scheduleId: scheduleIdSchema,
    serviceId: serviceIdSchema,
    scheduleVersion: version,
    createdAt: utcTimestampSchema,
    startsAt: utcTimestampSchema,
    endsAt: utcTimestampSchema,
    intervals: z.array(previewIntervalSchema).min(1).max(2000),
  })
  .superRefine((value, ctx) => {
    let cursor = value.startsAt;
    for (const interval of value.intervals) {
      if (
        Date.parse(interval.startsAt) !== Date.parse(cursor) ||
        Date.parse(interval.endsAt) <= Date.parse(interval.startsAt) ||
        (interval.assignment &&
          (Date.parse(interval.assignment.startsAt) >
            Date.parse(interval.startsAt) ||
            Date.parse(interval.assignment.endsAt) <
              Date.parse(interval.endsAt)))
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Preview intervals must provide contiguous coverage",
        });
        break;
      }
      cursor = interval.endsAt;
    }
    if (Date.parse(cursor) !== Date.parse(value.endsAt))
      ctx.addIssue({
        code: "custom",
        message: "Preview range differs from intervals",
      });
  });
export type ConfiguredPolicy = z.infer<typeof configuredPolicySchema>;
export type Availability = z.infer<typeof availabilitySchema>;
export type SchedulePreview = z.infer<typeof schedulePreviewSchema>;
/** Keep activation metadata out of immutable operational policy snapshots. */
export function policyDefinition(value: ConfiguredPolicy) {
  const parsed = configuredPolicySchema.parse(value);
  return escalationPolicySchema.parse(
    Object.fromEntries(
      Object.entries(parsed).filter(
        ([key]) =>
          !["enabled", "primaryPreviewId", "peerPreviewId"].includes(key),
      ),
    ),
  );
}
