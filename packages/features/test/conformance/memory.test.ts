import { foundationConformance } from "./foundation.js";
import { MemoryFoundationRepository } from "./memory.js";
foundationConformance("memory", async () => ({
  repository: new MemoryFoundationRepository({
    now: () => new Date("2026-09-18T00:00:00.000Z"),
  }),
  dispose: async () => {},
}));
