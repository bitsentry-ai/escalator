import { coverageConformance } from "./coverage.js";
import { MemoryCoverageRepository } from "./memory-coverage.js";
coverageConformance("memory deployment coverage", async () => {
  const repository = new MemoryCoverageRepository();
  return {
    repository,
    configuration: repository.configuration,
    work: repository.work,
    providerSecret: async () => "fixture-secret",
    dispose: async () => {},
  };
});
