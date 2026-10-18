import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import type { WorkspaceId } from "@bitsentry-escalator/features/contracts";
import {
  DurableWorkScheduler,
  type WorkHandlers,
  type WorkQueue,
} from "@bitsentry-escalator/features/application";
import { PostgresWorkStore } from "./postgres-work.store.js";
/** Constructed by the host with its trusted local workspace and owned pool. */
export class PostgresJobsRuntime
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly scheduler: DurableWorkScheduler;
  constructor(
    pool: Pool,
    workspaceId: WorkspaceId,
    handlers: WorkHandlers,
    onError: (queue: WorkQueue) => void,
    jobLanes?: readonly (readonly string[])[],
    jobConcurrency?: Readonly<Record<string, number>>,
  ) {
    this.scheduler = new DurableWorkScheduler(
      new PostgresWorkStore(pool),
      workspaceId,
      handlers,
      {
        leaseMs: 30_000,
        timeoutMs: 20_000,
        maxAttempts: 5,
        retryBaseMs: 1000,
        retryMaxMs: 60_000,
        token: randomUUID,
        random: Math.random,
      },
      { intervalMs: 5000, batchSize: 10, onError, jobLanes, jobConcurrency },
    );
  }
  onApplicationBootstrap(): void {
    this.scheduler.start();
  }
  async onModuleDestroy(): Promise<void> {
    await this.scheduler.stop();
  }
}
