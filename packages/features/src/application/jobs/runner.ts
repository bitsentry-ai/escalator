import type { WorkspaceId } from "../../contracts/index.js";
import type {
  DurableWorkStore,
  WorkLease,
  WorkQueue,
  WorkResult,
} from "./ports.js";

export type WorkHandler = (
  lease: WorkLease,
  signal: AbortSignal,
) => Promise<Extract<WorkResult, { state: "completed" }>>;
export interface RunnerOptions {
  leaseMs: number;
  timeoutMs: number;
  maxAttempts: number;
  retryBaseMs: number;
  retryMaxMs: number;
  token(): string;
  random(): number;
}
/** Bounded jitter applies only to this attempt, never another escalation deadline. */
export function retryDelay(
  attempt: number,
  options: Pick<RunnerOptions, "retryBaseMs" | "retryMaxMs" | "random">,
): number {
  const ceiling = Math.min(
    options.retryMaxMs,
    options.retryBaseMs * 2 ** Math.min(30, Math.max(0, attempt - 1)),
  );
  const sample = options.random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1)
    throw new Error("Invalid jitter source");
  return Math.max(1, Math.floor(ceiling / 2 + (sample * ceiling) / 2));
}
export class DurableWorkRunner {
  constructor(
    private readonly store: DurableWorkStore,
    private readonly handlers: Readonly<
      Record<WorkQueue, ReadonlyMap<string, WorkHandler>>
    >,
    private readonly options: RunnerOptions,
  ) {
    const { leaseMs, timeoutMs, maxAttempts, retryBaseMs, retryMaxMs } =
      options;
    if (
      ![leaseMs, timeoutMs, maxAttempts, retryBaseMs, retryMaxMs].every(
        Number.isSafeInteger,
      ) ||
      timeoutMs < 1 ||
      leaseMs < timeoutMs + 1000 ||
      leaseMs > 300_000 ||
      maxAttempts < 1 ||
      maxAttempts > 100 ||
      retryBaseMs < 1 ||
      retryMaxMs < retryBaseMs ||
      retryMaxMs > 3_600_000
    ) {
      throw new Error("Invalid durable runner bounds");
    }
  }
  async runOne(
    workspaceId: WorkspaceId,
    queue: WorkQueue,
  ): Promise<"idle" | "completed" | "retry" | "failed" | "stale"> {
    const handlers = this.handlers[queue];
    if (!handlers.size) return "idle";
    const lease = await this.store.claim({
      workspaceId,
      queue,
      token: this.options.token(),
      leaseMs: this.options.leaseMs,
      kinds: [...handlers.keys()],
    });
    if (!lease) return "idle";
    if (lease.attempt > this.options.maxAttempts) {
      return (await this.store.settle(lease, {
        state: "failed",
        outcome: "unknown",
      }))
        ? "failed"
        : "stale";
    }
    // The adapter has committed before any handler (including network I/O) starts.
    const handler = handlers.get(lease.kind);
    if (!handler) throw new Error("Claim returned an unregistered work kind");
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result: WorkResult;
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(new Error("Work attempt timed out"));
        }, this.options.timeoutMs);
      });
      result = await Promise.race([handler(lease, abort.signal), deadline]);
    } catch {
      // A failed/aborted external call may already have reached its provider.
      result =
        lease.attempt >= this.options.maxAttempts
          ? { state: "failed", outcome: "unknown" }
          : {
              state: "retry",
              delayMs: retryDelay(lease.attempt, this.options),
              outcome: "unknown",
            };
    } finally {
      clearTimeout(timer);
    }
    // The side effect may have happened; never let a missing outcome force redelivery.
    if (queue === "outbox" && result.outcome === undefined)
      result = { ...result, outcome: "unknown" };
    return (await this.store.settle(lease, result)) ? result.state : "stale";
  }
}
