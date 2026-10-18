import { RepositoryConnections } from "@bitsentry-escalator/features/investigation";
import type { Pool, PoolClient } from "pg";
import type { WorkspaceId } from "@bitsentry-escalator/features/contracts";
import {
  configurationTransaction,
  detectionTransaction,
  pagingTransaction,
  signalTransaction,
  withLiveRules,
  type RuleLiveRepository,
  type RuleLiveTransaction,
} from "@bitsentry-escalator/features/application";
import { PostgresFoundationRepository } from "./foundation.repository.js";
import { postgresPagingStore } from "./postgres-paging.store.js";
import { postgresConfigurationStore } from "./postgres-configuration.store.js";
import { postgresSignalStore } from "./postgres-signals.store.js";
import { postgresDetectionStore } from "./postgres-detection.store.js";
import {
  postgresRuleLiveStore,
  type PostgresRulePolicyStore,
} from "./postgres-rule-live.store.js";
import { withBoundedRulePool } from "./bounded-rule-pool.js";
export class PostgresRuleLiveRepository implements RuleLiveRepository {
  constructor(
    private readonly pool: Pool,
    private readonly policy: (
      db: PoolClient,
      scope: WorkspaceId,
    ) => PostgresRulePolicyStore,
    private readonly repositories = new RepositoryConnections(),
  ) {}
  transaction<T>(
    scope: WorkspaceId,
    work: (tx: RuleLiveTransaction) => Promise<T>,
  ): Promise<T> {
    return withBoundedRulePool(this.pool, (bounded) =>
      new PostgresFoundationRepository(bounded).withConnection(
        scope,
        async (base, db, guard) => {
          await db.query("SET LOCAL statement_timeout = '5s'");
          await db.query("SET LOCAL lock_timeout = '1s'");
          const configuration = configurationTransaction(
            pagingTransaction(
              base,
              postgresPagingStore(db, scope, this.repositories),
              guard,
            ),
            postgresConfigurationStore(db, scope),
            guard,
          );
          const signals = signalTransaction(
            base,
            postgresSignalStore(db, scope),
            guard,
          );
          const detection = detectionTransaction(
            { ...configuration, ...signals },
            postgresDetectionStore(db, scope),
            guard,
          );
          return work(
            withLiveRules(
              detection,
              postgresRuleLiveStore(db, scope, this.policy(db, scope)),
              guard,
            ),
          );
        },
      ),
    );
  }
}
