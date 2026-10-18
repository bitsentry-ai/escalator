import type { WorkHandlers } from "../jobs/scheduler.js";
import type { WorkHandler } from "../jobs/runner.js";
import type { MetricsRepository } from "./ports.js";
import type { PrometheusMetricsReader } from "../../adapters/metrics/reader.js";
import { MetricPollingJobs } from "./jobs.js";
export const metricJobLane = ["metrics.poll"] as const;
/** Preserve existing paging/detection handlers; host lifecycle owns the combined scheduler. */
export function withMetricHandlers(
  handlers: WorkHandlers,
  repository: MetricsRepository,
  reader: Pick<PrometheusMetricsReader, "read">,
): WorkHandlers {
  if (handlers.job.has("metrics.poll"))
    throw new Error("Metric handler already registered");
  const jobs = new MetricPollingJobs(repository, reader);
  return {
    job: new Map<string, WorkHandler>([
      ...handlers.job,
      ["metrics.poll", (lease, signal) => jobs.poll(lease, signal)],
    ]),
    outbox: handlers.outbox,
  };
}
