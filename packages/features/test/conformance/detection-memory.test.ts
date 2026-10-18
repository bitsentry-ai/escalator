import { detectionConformance } from "./detection.js";
import { MemoryDetectionRepository } from "./memory-detection.js";
detectionConformance("memory detection", async () => {
  const repository = new MemoryDetectionRepository();
  return {
    repository,
    work: repository.configuration.paging.foundation,
    dispose: async () => {},
  };
});
