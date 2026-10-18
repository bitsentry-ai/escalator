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
    units = candidate.enabled
      ? Math.ceil(candidate.config.timeoutMs / candidate.intervalSeconds)
      : 0;
  let after: string | undefined;
  do {
    const page = await tx.probes.list({ limit: 100, after });
    for (const probe of page.items)
      if (probe.id !== candidate.id) {
        count++;
        if (probe.enabled) {
          active++;
          units += Math.ceil(probe.config.timeoutMs / probe.intervalSeconds);
        }
      }
    if (count > limits.maxConfigured)
      throw new ProbeCapacityError("configured_limit");
    if (active > limits.maxActive) throw new ProbeCapacityError("active_limit");
    // Integer milliseconds per second, rounded up; reserve at least 20% for loop/DB overhead.
    if (units > limits.concurrency * 800)
      throw new ProbeCapacityError("request_budget");
    after = page.next ?? undefined;
  } while (after);
}
