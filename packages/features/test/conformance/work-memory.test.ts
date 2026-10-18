import { workConformance } from "./work.js";
import { MemoryFoundationRepository } from "./memory.js";
workConformance("memory durable work", async () => {
  const repository = new MemoryFoundationRepository({
    now: () => new Date("2026-09-19T00:00:00Z"),
  });
  return {
    repository,
    store: repository,
    reopen: () => ({
      claim: (input) => repository.claim(input),
      settle: (lease, result) => repository.settle(lease, result),
    }),
    committed: (lease) => repository.committed(lease),
    expire: (lease) => repository.expireLease(lease),
    dispose: async () => {},
  };
});
