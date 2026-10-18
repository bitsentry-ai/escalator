import { pagingConformance } from "./paging.js";
import { MemoryPagingRepository } from "./memory-paging.js";
pagingConformance("memory paging", async () => ({
  repository: new MemoryPagingRepository({
    now: () => new Date("2026-09-19T12:00:00.000Z"),
  }),
  dispose: async () => {},
}));
