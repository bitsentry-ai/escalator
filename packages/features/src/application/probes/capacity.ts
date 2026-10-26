import { z } from "zod";
import type { Probe } from "../../contracts/probes.js";
import type { ProbeTransaction } from "./ports.js";
export const probeLimitsSchema = z
  .strictObject({
    maxActive: z.number().int().min(1).max(1000),
    maxConfigured: z.number().int().min(1).max(10000),
    concurrency: z.number().int().min(1).max(32),
  })
  .refine((value) => value.maxConfigured >= value.maxActive);
export type ProbeLimits = z.infer<typeof probeLimitsSchema>;
export const defaultProbeLimits: Readonly<ProbeLimits> = Object.freeze({
  maxActive: 100,
  maxConfigured: 500,
  concurrency: 4,
});
export class ProbeCapacityError extends Error {
  constructor(
    readonly code: "configured_limit" | "active_limit" | "request_budget",
  ) {
    super(code);
  }
}
/** Integer milliseconds of requests per second, rounded up. */
const requestUnits = (value: Probe) =>
  Math.ceil(value.config.timeoutMs / value.intervalSeconds);
function assertWithinLimits(
  count: number,
  active: number,
  units: number,
  limits: { maxConfigured: number; maxActive: number; concurrency: number },
): void {
  if (count > limits.maxConfigured)
    throw new ProbeCapacityError("configured_limit");
  if (active > limits.maxActive) throw new ProbeCapacityError("active_limit");
  // Reserve at least 20% of each worker for loop and database overhead.
  if (units > limits.concurrency * 800)
    throw new ProbeCapacityError("request_budget");
}
/** Caller takes the scoped capacity lock before source/probe locks; count and write share a transaction. */
export async function assertProbeCapacity(
  tx: ProbeTransaction,
  candidate: Probe,
  limits: ProbeLimits,
): Promise<void> {
  probeLimitsSchema.parse(limits);
  await tx.probes.lockCapacity();
  let count = 1,
    active = candidate.enabled ? 1 : 0,
    units = candidate.enabled ? requestUnits(candidate) : 0;
  let after: string | undefined;
  do {
    const page = await tx.probes.list({ limit: 100, after });
    for (const probe of page.items) {
      if (probe.id === candidate.id) continue;
      count++;
      if (!probe.enabled) continue;
      active++;
      units += requestUnits(probe);
    }
    assertWithinLimits(count, active, units, limits);
    after = page.next ?? undefined;
  } while (after);
}
