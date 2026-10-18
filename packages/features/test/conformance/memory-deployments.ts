import type { TransactionGuard } from "../../src/application/ports/transaction-guard.js";
import type { ConfigurationTransaction } from "../../src/application/configuration/ports.js";
import {
  workspaceIdSchema,
  type Clock,
  type WorkspaceId,
  type DeploymentTarget,
  type DeploymentToken,
  type DeploymentEntry,
  type DeploymentReceipt,
} from "../../src/contracts/index.js";
import type {
  DeploymentRepository,
  DeploymentRecordStore,
  DeploymentTransaction,
} from "../../src/application/deploy/ports.js";
import { deploymentTransaction } from "../../src/application/deploy/transaction.js";
import {
  PersistenceError,
  type PageRequest,
} from "../../src/application/ports/persistence.js";
import { MemoryConfigurationRepository } from "./memory-configuration.js";
type Rows = {
  targets: DeploymentTarget[];
  tokens: DeploymentToken[];
  deployments: DeploymentEntry[];
  receipts: DeploymentReceipt[];
};
function rows(extensions: Record<string, unknown>): Rows {
  return (extensions.deployments ??= {
    targets: [],
    tokens: [],
    deployments: [],
    receipts: [],
  }) as Rows;
}
const copy = <T>(value: T): T => structuredClone(value);
function page<T>(values: T[], input: PageRequest, id: (value: T) => string) {
  const sorted = values
    .filter((value) => !input.after || id(value) > input.after)
    .sort((a, b) => (id(a) < id(b) ? -1 : id(a) === id(b) ? 0 : 1));
  return copy({
    items: sorted.slice(0, input.limit),
    next: sorted.length > input.limit ? id(sorted[input.limit - 1]) : null,
  });
}
/** Test-only serializable adapter. No production in-memory fallback. */
export class MemoryDeploymentRepository implements DeploymentRepository {
  readonly configuration: MemoryConfigurationRepository;
  constructor(
    private readonly clock: Clock = {
      now: () => new Date("2026-10-04T00:00:00.000Z"),
    },
  ) {
    this.configuration = new MemoryConfigurationRepository(clock);
  }
  get work() {
    return this.configuration.paging.foundation;
  }
  async findTokenContext(hash: string) {
    return this.work.withExtensions(
      workspaceIdSchema.parse("lookup"),
      async (_base, extensions) => {
        const value = rows(extensions).tokens.find(
          (token) => token.tokenHash === hash,
        );
        return value
          ? {
              workspaceId: value.workspaceId,
              targetId: value.targetId,
              id: value.id,
            }
          : undefined;
      },
    );
  }
  transaction<T>(
    scope: WorkspaceId,
    run: (tx: DeploymentTransaction) => Promise<T>,
  ): Promise<T> {
    return this.withExtensions(scope, (tx) => run(tx));
  }
  withExtensions<T>(
    scope: WorkspaceId,
    run: (
      tx: DeploymentTransaction,
      configuration: ConfigurationTransaction,
      extensions: Record<string, unknown>,
      guard: TransactionGuard,
    ) => Promise<T>,
  ): Promise<T> {
    return this.configuration.withExtensions(
      scope,
      (base, extensions, guard) => {
        const data = rows(extensions);
        const targets = () =>
          data.targets.filter((value) => value.workspaceId === scope);
        const tokens = () =>
          data.tokens.filter((value) => value.workspaceId === scope);
        const deployments = (targetId: string) =>
          data.deployments.filter(
            (value) =>
              value.deployment.workspaceId === scope &&
              value.targetId === targetId,
          );
        const receipts = (targetId: string) =>
          data.receipts.filter(
            (value) =>
              value.workspaceId === scope && value.targetId === targetId,
          );
        const store: DeploymentRecordStore = {
          currentTime: async () => this.clock.now().toISOString(),
          getPolicy: (id) => base.configuration.policies.get(id),
          getTarget: async (id) =>
            copy(targets().find((value) => value.id === id)),
          listTargets: async (query) =>
            page(targets(), query, (value) => value.id),
          insertTarget: async (value) => {
            if (
              targets().some(
                (row) =>
                  row.id === value.id ||
                  (row.serviceId === value.serviceId &&
                    row.environmentId === value.environmentId),
              )
            )
              throw new PersistenceError("already_exists");
            data.targets.push(copy(value));
          },
          replaceTarget: async (value, expected) => {
            const index = data.targets.findIndex(
              (row) =>
                row.workspaceId === scope &&
                row.id === value.id &&
                row.revision === expected,
            );
            if (index < 0) return false;
            data.targets[index] = copy(value);
            return true;
          },
          getTokenByHash: async (hash) =>
            copy(tokens().find((value) => value.tokenHash === hash)),
          getToken: async (id) =>
            copy(tokens().find((value) => value.id === id)),
          listTokens: async (targetId, query) =>
            page(
              tokens().filter((value) => value.targetId === targetId),
              query,
              (value) => value.id,
            ),
          insertToken: async (value) => {
            if (
              tokens().some((row) => row.id === value.id) ||
              data.tokens.some((row) => row.tokenHash === value.tokenHash)
            )
              throw new PersistenceError("already_exists");
            data.tokens.push(copy(value));
          },
          revokeToken: async (id, at) => {
            const row = data.tokens.find(
              (value) => value.workspaceId === scope && value.id === id,
            );
            if (!row) return false;
            row.revokedAt ??= at;
            return true;
          },
          getDeployment: async (targetId, id) =>
            copy(
              deployments(targetId).find((value) => value.deployment.id === id),
            ),
          findDeployment: async (targetId, source, externalId) =>
            copy(
              deployments(targetId).find(
                (value) =>
                  value.deployment.source === source &&
                  value.deployment.externalId === externalId,
              ),
            ),
          listDeployments: async (targetId, query) =>
            page(deployments(targetId), query, (value) => value.deployment.id),
          insertDeployment: async (value) => {
            if (
              data.deployments.some(
                (row) =>
                  row.deployment.workspaceId === scope &&
                  (row.deployment.id === value.deployment.id ||
                    (row.targetId === value.targetId &&
                      row.deployment.source === value.deployment.source &&
                      row.deployment.externalId ===
                        value.deployment.externalId)),
              )
            )
              throw new PersistenceError("already_exists");
            data.deployments.push(copy(value));
          },
          replaceDeployment: async (targetId, value, expected) => {
            const row = deployments(targetId).find(
              (row) =>
                row.deployment.id === value.id &&
                row.deployment.revision === expected,
            );
            if (!row) return false;
            row.deployment = copy(value);
            return true;
          },
          getReceipt: async (targetId, key) =>
            copy(receipts(targetId).find((value) => value.key === key)),
          insertReceipt: async (value) => {
            if (receipts(value.targetId).some((row) => row.key === value.key))
              throw new PersistenceError("already_exists");
            data.receipts.push(copy(value));
          },
        };
        return run(
          deploymentTransaction(base, store, guard),
          base,
          extensions,
          guard,
        );
      },
    );
  }
}
