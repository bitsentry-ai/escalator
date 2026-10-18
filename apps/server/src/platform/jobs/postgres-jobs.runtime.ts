import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import type { WorkspaceId } from "@bitsentry-escalator/features/contracts";
import {
  type RetentionCoordinator,
  DurableWorkScheduler,
  HealthDeployment,
  OperationalHealthCheck,
  WatchdogCoordinator,
  watchdogJobKind,
  type WorkHandlers,
  type WorkQueue,
} from "@bitsentry-escalator/features/application";
import { PostgresWorkStore } from "./postgres-work.store.js";
import { PostgresHealthReader } from "../health/postgres-health.reader.js";
import { PostgresFoundationRepository } from "../database/foundation.repository.js";
/** Constructed by the host with its trusted local workspace and owned pool. */
export class PostgresJobsRuntime
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly scheduler: DurableWorkScheduler;
  readonly health: OperationalHealthCheck;
  private readonly watchdog?: WatchdogCoordinator;
  constructor(
    pool: Pool,
    workspaceId: WorkspaceId,
    handlers: WorkHandlers,
    onError: (queue: WorkQueue) => void,
    jobLanes?: readonly (readonly string[])[],
    jobConcurrency?: Readonly<Record<string, number>>,
    health = new HealthDeployment(),
    private readonly retention?: RetentionCoordinator,
  ) {
    if (
      health.watchdog &&
      !handlers.job.has(watchdogJobKind(workspaceId, health.watchdog))
    )
      throw new Error("Watchdog configuration requires its durable handler");
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
    this.health = new OperationalHealthCheck(
      new PostgresHealthReader(pool),
      workspaceId,
      () => this.scheduler.progress(),
      health.policy,
    );
    if (health.watchdog)
      this.watchdog = new WatchdogCoordinator(
        new PostgresFoundationRepository(pool),
        workspaceId,
        health.watchdog,
        () => onError("job"),
      );
  }
  onApplicationBootstrap(): void {
    this.scheduler.start();
    this.watchdog?.start();
    this.retention?.start();
  }
  async onModuleDestroy(): Promise<void> {
    await Promise.all([
      this.scheduler.stop(),
      this.watchdog?.stop(),
      this.retention?.stop(),
    ]);
  }
}
