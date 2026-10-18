import { configurationConformance } from "./configuration.js";
import { MemoryConfigurationRepository } from "./memory-configuration.js";
configurationConformance("memory configuration", async () => ({
  repository: new MemoryConfigurationRepository(),
  dispose: async () => {},
}));
