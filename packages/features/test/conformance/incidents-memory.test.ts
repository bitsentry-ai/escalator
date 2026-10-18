import { incidentConformance } from "./incidents.js";
import { MemoryConfigurationRepository } from "./memory-configuration.js";
incidentConformance("memory incidents", async () => ({
  repository: new MemoryConfigurationRepository(),
  dispose: async () => {},
}));
