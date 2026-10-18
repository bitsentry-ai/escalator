import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type {
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from "@nestjs/common";
import {
  workspaceIdSchema,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import {
  RuleProposalConsumer,
  RuleProposalGeneration,
} from "@bitsentry-escalator/features/application";
import { BoundedModelHttp } from "@bitsentry-escalator/features/investigation";
import { PostgresRuleProposalRepository } from "../../../platform/database/rule-proposal.repository.js";
import { PostgresRuleProposalClaims } from "../../../platform/database/rule-proposal-claims.js";
import { PostgresRuleProposalModelAccess } from "../../../platform/database/rule-proposal-model-access.js";
import type { SecretKeyRing } from "../../../platform/secrets/keyring.js";
import type { StandaloneInvestigationDeployment } from "../investigation/deployment.js";
import { standaloneRuleProposalExecution } from "./execution.js";
/** A private pool and one model slot preserve paging and investigation capacity.
 * The existing AI deployment's enablement and egress rules also govern proposals. */
export class StandaloneRuleProposalRuntime
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly pool: Pool | undefined;
  private readonly consumer: RuleProposalConsumer | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  constructor(
    connectionString: string,
    workspaceId: WorkspaceId,
    keys: SecretKeyRing,
    private readonly deployment: StandaloneInvestigationDeployment,
    private readonly onError: () => void,
  ) {
    workspaceIdSchema.parse(workspaceId);
    if (!deployment.enabled) return;
    if (!connectionString)
      throw new Error("ESCALATOR_DATABASE_URL is required");
    const pool = new Pool({
      connectionString,
      max: 3,
      statement_timeout: 5000,
      connectionTimeoutMillis: 1000,
      idleTimeoutMillis: 30000,
    });
    this.pool = pool;
    pool.on("error", () => this.failed());
    const repository = new PostgresRuleProposalRepository(pool),
      claims = new PostgresRuleProposalClaims(pool);
    const generation = new RuleProposalGeneration(repository);
    this.consumer = new RuleProposalConsumer(
      {
        claim: (input) => claims.claim(input),
        heartbeat: (claim) => claims.heartbeat(claim),
        prepare: (claim) => generation.prepareInput(claim),
        complete: (claim, result) => generation.complete(claim, result),
        failed: (claim) => generation.failed(claim),
      },
      standaloneRuleProposalExecution(
        new PostgresRuleProposalModelAccess(repository),
        keys,
        new BoundedModelHttp(deployment.policy),
      ),
      { workspaceId, runtimeId: randomUUID(), token: randomUUID },
      (state) => {
        if (state !== "published" && state !== "stopped") this.failed();
      },
    );
  }
  private failed(): void {
    try {
      this.onError();
    } catch {
      /* Telemetry cannot stop polling. */
    }
  }
  onApplicationBootstrap(): void {
    if (this.consumer && !this.stopped && !this.timer)
      this.timer = setTimeout(() => void this.poll(), 0);
  }
  private async poll(): Promise<void> {
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
  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.consumer?.stop();
    await this.pool?.end();
  }
}
