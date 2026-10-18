import { createHash } from "node:crypto";
import type { MetricMonitor } from "../../contracts/metric-records.js";
import { utcTimestampSchema } from "../../contracts/entities.js";
export function metricJobId(
  scope: string,
  id: string,
  version: number,
  dueAt: string,
): string {
  return `metrics.poll:${createHash("sha256")
    .update(JSON.stringify([scope, id, version, dueAt]))
    .digest("hex")}`;
}
export function metricPointAt(now: string, stepSeconds: number): string {
  utcTimestampSchema.parse(now);
  if (!Number.isInteger(stepSeconds) || stepSeconds < 60 || stepSeconds > 3600)
    throw new Error("Invalid metric step");
  const step = stepSeconds * 1000;
  return new Date(Math.floor(Date.parse(now) / step) * step).toISOString();
}
export function metricWindowAt(monitor: MetricMonitor, endAt: string) {
  utcTimestampSchema.parse(endAt);
  return {
    startAt: new Date(
      Date.parse(endAt) -
        (monitor.rule.windowSeconds - monitor.stepSeconds) * 1000,
    ).toISOString(),
    endAt,
    stepSeconds: monitor.stepSeconds,
  };
}
export function nextMetricDueAt(
  dueAt: string,
  now: string,
  stepSeconds: number,
) {
  utcTimestampSchema.parse(dueAt);
  utcTimestampSchema.parse(now);
  if (!Number.isInteger(stepSeconds) || stepSeconds < 60 || stepSeconds > 3600)
    throw new Error("Invalid metric step");
  const step = stepSeconds * 1000;
  const slots = Math.max(
    1,
    Math.floor((Date.parse(now) - Date.parse(dueAt)) / step) + 1,
  );
  return {
    dueAt: new Date(Date.parse(dueAt) + slots * step).toISOString(),
    skippedSlots: slots - 1,
  };
}
