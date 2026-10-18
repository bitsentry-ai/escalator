import { heartbeatConformance } from "./conformance/heartbeats.js";
import { MemoryHeartbeatRepository } from "./conformance/memory-heartbeats.js";
heartbeatConformance("memory heartbeats", async () => ({
  repository: new MemoryHeartbeatRepository(),
  dispose: async () => {},
}));
