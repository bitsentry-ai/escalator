import { z } from "zod";
import type { MetricMonitor } from "../../contracts/metric-records.js";
import type { MetricsTransaction } from "./ports.js";
export const metricLimitsSchema = z
  .strictObject({
    maxActive: z.number().int().min(1).max(1000),
    maxConfigured: z.number().int().min(1).max(10000),
    concurrency: z.number().int().min(1).max(32),
  })
  .refine((value) => value.maxConfigured >= value.maxActive);
export type MetricLimits = z.infer<typeof metricLimitsSchema>;
export const defaultMetricLimits: Readonly<MetricLimits> = Object.freeze({
  maxActive: 100,
  maxConfigured: 500,
  concurrency: 4,
});
export class MetricCapacityError extends Error {
  constructor(
    readonly code: "configured_limit" | "active_limit" | "request_budget",
  ) {
    super(code);
  }
}
/** Caller takes the scoped capacity lock before source/metric locks; count and write share a transaction. */
export async function assertMetricCapacity(
  tx: MetricsTransaction,
  candidate: MetricMonitor,
  limits: MetricLimits,
): Promise<void> {
  metricLimitsSchema.parse(limits);
  await tx.metrics.lockCapacity();
  let count = 1,
    active = candidate.enabled ? 1 : 0,
    units = candidate.enabled ? Math.ceil(10000 / candidate.stepSeconds) : 0;
  let after: string | undefined;
  do {
    const page = await tx.metrics.list({ limit: 100, after });
    for (const metric of page.items)
      if (metric.id !== candidate.id) {
        count++;
        if (metric.enabled) {
          active++;
          units += Math.ceil(10000 / metric.stepSeconds);
        }
      }
    if (count > limits.maxConfigured)
      throw new MetricCapacityError("configured_limit");
    if (active > limits.maxActive)
      throw new MetricCapacityError("active_limit");
    // Integer milliseconds per second, rounded up; reserve at least 20% for loop/DB overhead.
    if (units > limits.concurrency * 800)
      throw new MetricCapacityError("request_budget");
    after = page.next ?? undefined;
  } while (after);
}
