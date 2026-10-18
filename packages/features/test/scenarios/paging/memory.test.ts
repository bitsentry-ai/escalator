import { MemoryPagingRepository } from "../../conformance/memory-paging.js";
import { pagingFailureScenarios } from "./scenarios.js";
pagingFailureScenarios("memory paging failures", async () => {
  const repository = new MemoryPagingRepository({ now: () => new Date() });
  return {
    repository,
    work: repository.foundation,
    reopen: () => ({ transaction: repository.transaction.bind(repository) }),
    dispose: async () => {},
  };
});
