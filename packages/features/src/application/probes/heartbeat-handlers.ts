import type { WorkHandlers } from "../jobs/scheduler.js";
import type { WorkHandler } from "../jobs/runner.js";
import type { HeartbeatRepository } from "./heartbeat-ports.js";
import { HeartbeatJobs } from "./heartbeat-jobs.js";
export const heartbeatJobLane = ["heartbeat.deadline"] as const;
/** Reserve a polling lane for deadlines without replacing paging or probe handlers. */
export function withHeartbeatHandlers(
  handlers: WorkHandlers,
  repository: HeartbeatRepository,
): WorkHandlers {
  if (handlers.job.has("heartbeat.deadline"))
    throw new Error("Heartbeat handler already registered");
  const jobs = new HeartbeatJobs(repository);
  return {
    job: new Map<string, WorkHandler>([
      ...handlers.job,
      ["heartbeat.deadline", (lease) => jobs.miss(lease)],
    ]),
    outbox: handlers.outbox,
  };
}
