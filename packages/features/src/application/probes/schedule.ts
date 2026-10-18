import { z } from "zod";
import { opaqueIdSchema, workspaceIdSchema } from "../../contracts/identity.js";
import { utcTimestampSchema } from "../../contracts/entities.js";
import { createHash } from "node:crypto";
export const probeScheduleSchema = z
  .strictObject({
    probeId: opaqueIdSchema,
    workspaceId: workspaceIdSchema,
    probeVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    jobId: opaqueIdSchema.nullable(),
    dueAt: utcTimestampSchema.nullable(),
  })
  .refine((value) => (value.jobId === null) === (value.dueAt === null));
export type ProbeSchedule = z.infer<typeof probeScheduleSchema>;
export function probeJobId(
  workspaceId: string,
  probeId: string,
  version: number,
  dueAt: string,
): string {
  return `probe.execute:${createHash("sha256")
    .update(JSON.stringify([workspaceId, probeId, version, dueAt]))
    .digest("hex")}`;
}
/** Skip missed slots; do not replay synthetic requests for periods when the scheduler was down. */
export function nextProbeDueAt(
  previous: string,
  now: string,
  intervalSeconds: number,
): string {
  const start = Date.parse(utcTimestampSchema.parse(previous));
  const current = Date.parse(utcTimestampSchema.parse(now));
  if (
    !Number.isSafeInteger(intervalSeconds) ||
    intervalSeconds < 60 ||
    intervalSeconds > 3600
  )
    throw new Error("Invalid probe interval");
  const step = intervalSeconds * 1000;
  const slots = Math.max(1, Math.floor((current - start) / step) + 1);
  return new Date(start + slots * step).toISOString();
}
