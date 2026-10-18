import { z } from "zod";
import {
  type ResponderId,
  opaqueIdSchema,
  responderIdSchema,
  serviceIdSchema,
  workspaceIdSchema,
} from "./identity.js";
import { timeZoneSchema, utcTimestampSchema } from "./entities.js";
export const scheduleIdSchema = opaqueIdSchema.brand<"ScheduleId">();
export type ScheduleId = z.infer<typeof scheduleIdSchema>;
export const rotationSchema = z.strictObject({
  id: opaqueIdSchema,
  timeZone: timeZoneSchema,
  anchorLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
  shiftDays: z.number().int().min(1).max(28),
  responders: z.array(responderIdSchema).min(1).max(100),
  priority: z.number().int().min(0).max(100).default(0),
  disambiguation: z
    .enum(["compatible", "earlier", "later"])
    .default("compatible"),
  until: utcTimestampSchema.nullable().default(null),
});
export const scheduleOverrideSchema = z
  .strictObject({
    id: opaqueIdSchema,
    responderId: responderIdSchema,
    startsAt: utcTimestampSchema,
    endsAt: utcTimestampSchema,
    approved: z.boolean(),
  })
  .refine(
    (value) => Date.parse(value.startsAt) < Date.parse(value.endsAt),
    "Override interval must be positive",
  );
export const scheduleSchema = z.strictObject({
  id: scheduleIdSchema,
  workspaceId: workspaceIdSchema,
  serviceId: serviceIdSchema,
  name: z.string().trim().min(1).max(200),
  version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  enabled: z.boolean(),
  rotations: z.array(rotationSchema).max(50),
  overrides: z.array(scheduleOverrideSchema).max(200),
});
export const workingHoursSchema = z.strictObject({
  responderId: responderIdSchema,
  timeZone: timeZoneSchema,
  windows: z
    .array(
      z
        .strictObject({
          weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
          startMinute: z.number().int().min(0).max(1439),
          endMinute: z.number().int().min(0).max(1440),
        })
        .refine(
          (value) => value.startMinute !== value.endMinute,
          "Working window must be nonempty",
        ),
    )
    .max(28),
});
export type Rotation = z.infer<typeof rotationSchema>;
export type ScheduleOverride = z.infer<typeof scheduleOverrideSchema>;
export type Schedule = z.infer<typeof scheduleSchema>;
export type WorkingHours = z.infer<typeof workingHoursSchema>;

export interface ScheduleAssignment {
  responderId: ResponderId;
  source: "rotation" | "override";
  sourceId: string;
  /** Source interval; preview intervals carry the effective coverage boundaries. */
  startsAt: string;
  endsAt: string;
}
export interface SchedulePreviewInterval {
  startsAt: string;
  endsAt: string;
  assignment: ScheduleAssignment | null;
}
