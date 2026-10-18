import { RepositoryConnections } from "@bitsentry-escalator/features/investigation";
import { randomUUID } from "node:crypto";
import type {
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from "@nestjs/common";
import { Pool } from "pg";
import {
  workspaceIdSchema,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import {
  InvestigationConsumer,
  BoundedModelHttp,
} from "@bitsentry-escalator/features/investigation";
import { PostgresInvestigationRepository } from "../../../platform/database/postgres-investigation.repository.js";
import type { SecretKeyRing } from "../../../platform/secrets/keyring.js";
import { standaloneInvestigationConfiguration } from "./configuration.js";
import { standaloneInvestigationExecution } from "./execution.js";
import type { StandaloneInvestigationDeployment } from "./deployment.js";
/** Own pool and timer; no registration in the paging consumer or Bull. */
export class StandaloneInvestigationRuntime
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly pool: Pool | undefined;
  private readonly consumer: InvestigationConsumer | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  constructor(
    connectionString: string,
    workspaceId: WorkspaceId,
    keys: SecretKeyRing,
    private readonly deployment: StandaloneInvestigationDeployment,
    private readonly onError: () => void,
    repositoryConnections = new RepositoryConnections(),
  ) {
    workspaceIdSchema.parse(workspaceId);
    if (!deployment.enabled) return;
    if (!connectionString)
      throw new Error("ESCALATOR_DATABASE_URL is required");
    const runtimeId = randomUUID();
    const pool = new Pool({
      connectionString,
      max: deployment.concurrency * 2 + 1,
      statement_timeout: 5000,
      connectionTimeoutMillis: 1000,
      idleTimeoutMillis: 30000,
    });
    this.pool = pool;
    pool.on("error", () => this.failed());
    const repository = new PostgresInvestigationRepository(
      pool,
      {
        authorizeRuntime: async (_db, scope, id) =>
          scope === workspaceId && id === runtimeId,
        configuration: (db, scope, id) =>
          standaloneInvestigationConfiguration(
            db,
            scope,
            id,
            repositoryConnections,
          ),
      },
      3,
      repositoryConnections,
    );
    this.consumer = new InvestigationConsumer(
      repository,
      standaloneInvestigationExecution(
        repository,
        keys,
        new BoundedModelHttp(deployment.policy),
      ),
      {
        workspaceId,
        runtimeId,
        concurrency: deployment.concurrency,
        token: randomUUID,
      },
      (state) => {
        if (state !== "published" && state !== "cancelled") this.failed();
      },
    );
  }
  private failed() {
    try {
      this.onError();
    } catch {
      /* Diagnostics cannot stop durable work. */
    }
  }
  onApplicationBootstrap() {
    if (this.consumer && !this.stopped && !this.timer)
      this.timer = setTimeout(() => void this.poll(), 0);
  }
  private async poll() {
    if (this.stopped || !this.consumer) return;
    try {
      await this.consumer.tick();
    } catch {
      this.failed();
    } finally {
      if (!this.stopped)
        this.timer = setTimeout(
          () => void this.poll(),
          this.deployment.pollEveryMs,
        );
    }
  }
  async onApplicationShutdown() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.consumer?.stop();
    await this.pool?.end();
  }
}
