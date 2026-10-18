import type { WorkHandlers } from "../jobs/scheduler.js";
import type { WorkHandler } from "../jobs/runner.js";
import type { ProbeRepository } from "./ports.js";
import type { HttpProbeRunner } from "./http-runner.js";
import { ProbeExecutionJobs } from "./execute.js";
export const probeJobLane = ["probe.execute"] as const;
/** Preserve existing paging/detection handlers; host lifecycle owns the combined scheduler. */
export function withProbeHandlers(
  handlers: WorkHandlers,
  repository: ProbeRepository,
  runner: Pick<HttpProbeRunner, "run">,
): WorkHandlers {
  if (handlers.job.has("probe.execute"))
    throw new Error("Probe handler already registered");
  const jobs = new ProbeExecutionJobs(repository, runner);
  return {
    job: new Map<string, WorkHandler>([
      ...handlers.job,
      ["probe.execute", (lease, signal) => jobs.execute(lease, signal)],
    ]),
    outbox: handlers.outbox,
  };
}
