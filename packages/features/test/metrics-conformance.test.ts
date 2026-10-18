import { metricsConformance } from "./conformance/metrics.js";
import { MemoryMetricsRepository } from "./conformance/memory-metrics.js";
metricsConformance("memory metrics", async () => ({
  repository: new MemoryMetricsRepository(),
  dispose: async () => {},
}));
