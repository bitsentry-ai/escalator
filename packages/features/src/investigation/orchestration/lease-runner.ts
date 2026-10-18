import { z } from "zod";
import { utcTimestampSchema } from "../../contracts/index.js";
import type {
  InvestigationClaim,
  InvestigationRepository,
  InvestigationRunResult,
} from "../ports/index.js";
import {
  investigationClaimSchema,
  validateInvestigationResult,
} from "./claims.js";
const optionsSchema = z
  .strictObject({
    leaseMs: z.number().int().min(3000).max(120000),
    heartbeatEveryMs: z.number().int().min(10),
    operationTimeoutMs: z.number().int().min(10).max(5000),
  })
  .refine(
    (value) =>
      value.heartbeatEveryMs <= value.leaseMs / 3 &&
      value.operationTimeoutMs <= value.leaseMs / 3,
    "Lease needs renewal headroom",
  );
export type InvestigationLeaseOptions = z.infer<typeof optionsSchema>;
export const defaultInvestigationLeaseOptions: Readonly<InvestigationLeaseOptions> =
  Object.freeze({
    leaseMs: 30000,
    heartbeatEveryMs: 10000,
    operationTimeoutMs: 5000,
  });
export type InvestigationExecution = (
  claim: InvestigationClaim,
  signal: AbortSignal,
) => Promise<InvestigationRunResult>;
export interface InvestigationExecutionOutcome {
  state:
    | "published"
    | "lease_lost"
    | "cancelled"
    | "execution_failed"
    | "publication_unknown";
  /** Local output only unless state is published; never log raw evidence/report text. */
  result: InvestigationRunResult | null;
}
class Stopped extends Error {}
class Deadline extends Error {}
/** Does not physically terminate a host port ignoring cancellation. Host DB/HTTP timeouts
 * must bound resource use. Rejection handlers remain attached to late promises.
 */
async function waitFor<T>(
  work: () => Promise<T>,
  signal: AbortSignal,
  ms: number,
): Promise<T> {
  if (signal.aborted) throw new Stopped();
  let rejectStop: () => void = () => {};
  const stopped = new Promise<never>((_, reject) => {
    rejectStop = () => reject(new Stopped());
  });
  signal.addEventListener("abort", rejectStop, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Deadline()), ms);
  });
  const operation = Promise.resolve().then(() => {
    if (signal.aborted) throw new Stopped();
    return work();
  });
  try {
    return await Promise.race([operation, stopped, expired]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", rejectStop);
  }
}
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}
/** Shared by worker and in-process hosts. The host authenticates/claims before calling.
 * Runtime shutdown leaves the durable intent reclaimable; it is not a user cancellation.
 * Publish uncertainty is explicit because a response can be lost after a DB commit.
 */
export async function executeInvestigationClaim(
  input: InvestigationClaim,
  repository: Pick<InvestigationRepository, "heartbeat" | "publish">,
  execute: InvestigationExecution,
  signal: AbortSignal,
  settings: InvestigationLeaseOptions = defaultInvestigationLeaseOptions,
): Promise<InvestigationExecutionOutcome> {
  const claim = investigationClaimSchema.parse(input);
  const options = optionsSchema.parse(settings);
  const work = new AbortController();
  const stopHeartbeat = new AbortController();
  let lost = false;
  let result: InvestigationRunResult | null = null;
  const cancel = () => {
    work.abort();
    stopHeartbeat.abort();
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const unavailable = (): InvestigationExecutionOutcome => ({
    state: signal.aborted ? "cancelled" : "lease_lost",
    result,
  });
  const renew = async () => {
    const renewed = await waitFor(
      () => repository.heartbeat(structuredClone(claim), options.leaseMs),
      stopHeartbeat.signal,
      options.operationTimeoutMs,
    );
    if (
      !renewed ||
      !utcTimestampSchema.safeParse(renewed.leaseExpiresAt).success
    )
      throw new Stopped();
    // Metadata only; future heartbeat/publish must still check persisted DB expiry.
    claim.leaseExpiresAt = renewed.leaseExpiresAt;
  };
  let heartbeat: Promise<void> | undefined;
  try {
    try {
      await renew();
    } catch {
      return unavailable();
    }
    if (signal.aborted) return unavailable();
    heartbeat = (async () => {
      while (!stopHeartbeat.signal.aborted) {
        await sleep(options.heartbeatEveryMs, stopHeartbeat.signal);
        if (stopHeartbeat.signal.aborted) break;
        try {
          await renew();
        } catch {
          if (!stopHeartbeat.signal.aborted) {
            lost = true;
            work.abort();
          }
          break;
        }
      }
    })();
    try {
      // Allow the bounded engine to return its partial report at its own deadline.
      const value = await waitFor(
        () => execute(structuredClone(claim), work.signal),
        work.signal,
        claim.limits.maxDurationMs + 1000,
      );
      if (signal.aborted || lost) return unavailable();
      result = validateInvestigationResult(claim, value);
    } catch {
      return signal.aborted || lost
        ? unavailable()
        : { state: "execution_failed", result: null };
    }
    if (signal.aborted || lost) return unavailable();
    try {
      const captured = result;
      const published = await waitFor(
        () =>
          repository.publish(structuredClone(claim), structuredClone(captured)),
        work.signal,
        options.operationTimeoutMs,
      );
      return { state: published === true ? "published" : "lease_lost", result };
    } catch {
      // Do not retry a publication/model here: the transaction may have committed.
      return { state: "publication_unknown", result };
    }
  } finally {
    stopHeartbeat.abort();
    work.abort();
    signal.removeEventListener("abort", cancel);
    await heartbeat;
  }
}
