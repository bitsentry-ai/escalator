import { signalConformance } from "./signals.js";
import { MemorySignalRepository } from "./memory-signals.js";
signalConformance("memory signals", async () => {
  const repository = new MemorySignalRepository();
  return { repository, work: repository.foundation, dispose: async () => {} };
});
