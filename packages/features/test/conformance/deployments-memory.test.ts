import { deploymentConformance } from "./deployments.js";
import { MemoryDeploymentRepository } from "./memory-deployments.js";
deploymentConformance("memory deployments", async () => {
  const repository = new MemoryDeploymentRepository();
  return {
    repository,
    configuration: repository.configuration,
    work: repository.work,
    dispose: async () => {},
  };
});
