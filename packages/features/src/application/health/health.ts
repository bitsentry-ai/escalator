import type { WorkspaceId } from "../../contracts/index.js";
import { utcTimestampSchema } from "../../contracts/index.js";
import type { SchedulerProgress } from "./progress.js";
export interface QueueHealthSnapshot {
  databaseNow: string;
  oldestDueJobAt: string | null;
  oldestDueOutboxAt: string | null;
  oldestDuePagingAt: string | null;
}
/** Fresh scoped query, including running rows; implementations bound acquisition and SQL.
 * Exclude watchdogJobPrefix intents: monitoring delivery must not gate its own recovery.
 */
export interface OperationalHealthReader {
  read(
    workspaceId: WorkspaceId,
    signal: AbortSignal,
  ): Promise<QueueHealthSnapshot>;
}
export interface HealthPolicy {
  queryTimeoutMs: number;
  maxSchedulerAgeMs: number;
  maxPagingLagMs: number;
  maxJobLagMs: number;
}
export const defaultHealthPolicy: Readonly<HealthPolicy> = Object.freeze({
  queryTimeoutMs: 5000,
  maxSchedulerAgeMs: 60000,
  maxPagingLagMs: 60000,
  maxJobLagMs: 300000,
});
export type HealthReason =
  | "database_unavailable"
  | "scheduler_unavailable"
  | "scheduler_stalled"
  | "paging_overdue"
  | "jobs_overdue"
  | "outbox_overdue";
export interface OperationalHealth {
  ready: boolean;
  reasons: HealthReason[];
  databaseNow: string | null;
  schedulerMaxAgeMs: number | null;
  lagMs: { jobs: number | null; outbox: number | null; paging: number | null };
}
function unavailable(reason: HealthReason): OperationalHealth {
  return {
    ready: false,
    reasons: [reason],
    databaseNow: null,
    schedulerMaxAgeMs: null,
    lagMs: { jobs: null, outbox: null, paging: null },
  };
}
export function evaluateHealth(
  snapshot: QueueHealthSnapshot,
  progress: ReturnType<SchedulerProgress["snapshot"]>,
  policy: HealthPolicy,
): OperationalHealth {
  const now = Date.parse(utcTimestampSchema.parse(snapshot.databaseNow));
  const lag = (value: string | null): number | null => {
    if (value === null) return null;
    const time = Date.parse(utcTimestampSchema.parse(value));
    if (time > now) throw new Error("Invalid due-job health timestamp");
    return now - time;
  };
  const lagMs = {
    jobs: lag(snapshot.oldestDueJobAt),
    outbox: lag(snapshot.oldestDueOutboxAt),
    paging: lag(snapshot.oldestDuePagingAt),
  };
  const reasons: HealthReason[] = [];
  const ages = progress.laneAgeMs;
  const known =
    ages.length > 0 &&
    ages.length <= 65 &&
    ages.every((age) => age !== null && Number.isFinite(age) && age >= 0);
  const schedulerMaxAgeMs = known ? Math.max(...(ages as number[])) : null;
  if (!progress.running || schedulerMaxAgeMs === null)
    reasons.push("scheduler_unavailable");
  else if (schedulerMaxAgeMs > policy.maxSchedulerAgeMs)
    reasons.push("scheduler_stalled");
  if (lagMs.paging !== null && lagMs.paging > policy.maxPagingLagMs)
    reasons.push("paging_overdue");
  if (lagMs.jobs !== null && lagMs.jobs > policy.maxJobLagMs)
    reasons.push("jobs_overdue");
  if (lagMs.outbox !== null && lagMs.outbox > policy.maxPagingLagMs)
    reasons.push("outbox_overdue");
  return {
    ready: reasons.length === 0,
    reasons,
    databaseNow: snapshot.databaseNow,
    schedulerMaxAgeMs,
    lagMs,
  };
}
/** Coalesces simultaneous checks and never starts more reads behind a stranded query. */
export class OperationalHealthCheck {
  private pending: Promise<OperationalHealth> | undefined;
  private reading = false;
  readonly policy: Readonly<HealthPolicy>;
  constructor(
    private readonly reader: OperationalHealthReader,
    private readonly workspaceId: WorkspaceId,
    private readonly progress: () => ReturnType<SchedulerProgress["snapshot"]>,
    policy: HealthPolicy = defaultHealthPolicy,
    private readonly now: () => number = () => performance.now(),
  ) {
    if (
      ![
        policy.queryTimeoutMs,
        policy.maxSchedulerAgeMs,
        policy.maxPagingLagMs,
        policy.maxJobLagMs,
      ].every(Number.isSafeInteger) ||
      policy.queryTimeoutMs < 1 ||
      policy.queryTimeoutMs > 5000 ||
      policy.maxSchedulerAgeMs < 1000 ||
      policy.maxSchedulerAgeMs > 300000 ||
      policy.maxPagingLagMs < 1000 ||
      policy.maxPagingLagMs > 300000 ||
      policy.maxJobLagMs < 1000 ||
      policy.maxJobLagMs > 3600000
    )
      throw new Error("Invalid operational health limits");
    this.policy = Object.freeze({ ...policy });
  }
  check(): Promise<OperationalHealth> {
    if (this.pending) return this.pending;
    if (this.reading)
      return Promise.resolve(unavailable("database_unavailable"));
    this.pending = this.run().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private async run(): Promise<OperationalHealth> {
    const controller = new AbortController();
    const started = this.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    this.reading = true;
    const operation = Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();
        return this.reader.read(this.workspaceId, controller.signal);
      })
      .finally(() => {
        this.reading = false;
      });
    try {
      const snapshot = await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("Health query timed out"));
          }, this.policy.queryTimeoutMs);
        }),
      ]);
      const elapsed = this.now() - started;
      if (
        !Number.isFinite(elapsed) ||
        elapsed < 0 ||
        elapsed > this.policy.queryTimeoutMs
      )
        return unavailable("database_unavailable");
      let progress: ReturnType<SchedulerProgress["snapshot"]>;
      try {
        progress = this.progress();
      } catch {
        return unavailable("scheduler_unavailable");
      }
      return evaluateHealth(snapshot, progress, this.policy);
    } catch {
      return unavailable("database_unavailable");
    } finally {
      clearTimeout(timer);
    }
  }
}
