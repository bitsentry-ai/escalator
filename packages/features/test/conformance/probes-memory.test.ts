import { probeConformance } from "./probes.js";
import { MemoryProbeRepository } from "./memory-probes.js";
probeConformance("memory probes", async () => {
  const repository = new MemoryProbeRepository();
  return {
    repository,
    work: repository.signals.foundation,
    dispose: async () => {},
  };
});
