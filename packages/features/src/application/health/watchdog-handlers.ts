import type { WorkHandlers } from "../jobs/scheduler.js";
import type { WatchdogJobs } from "./watchdog.js";
/** The per-configuration kind keeps rolling replicas from stealing each other’s jobs. */
export function withWatchdogHandlers(
  handlers: WorkHandlers,
  jobs: WatchdogJobs,
): WorkHandlers {
  if (handlers.job.has(jobs.kind))
    throw new Error("Watchdog handler is already registered");
  return {
    ...handlers,
    job: new Map([
      ...handlers.job,
      [jobs.kind, (lease, signal) => jobs.run(lease, signal)],
    ]),
  };
}
