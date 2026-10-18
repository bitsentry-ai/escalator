import { deploymentSchema } from "../../contracts/index.js";
import { PersistenceError } from "../ports/persistence.js";
import type { TransactionGuard } from "../ports/transaction-guard.js";
import { pagingWorkId } from "../paging/work-ids.js";
import type { DeploymentWatchTransaction } from "./watch-persistence.js";
/** Use only when both watch and cadence handlers are registered. The accepted
 * lifecycle finish, watch/pins and both work intents commit together. Cadence is
 * a separate job so it can acquire capacity before target/source locks.
 */
export function withDeploymentWatchJobs<Tx extends DeploymentWatchTransaction>(
  base: Tx,
  guard: TransactionGuard,
): Tx {
  return {
    ...base,
    deployments: {
      ...base.deployments,
      replace: (targetId, raw, expectedRevision) =>
        guard.operation(async () => {
          const value = deploymentSchema.parse(raw);
          const previous = await base.deployments.get(targetId, value.id);
          if (!previous) throw new PersistenceError("not_found");
          const changed = await base.deployments.replace(
            targetId,
            value,
            expectedRevision,
          );
          if (!changed || previous.deployment.finish || !value.finish)
            return changed;
          const watch = await base.watches.initialize(targetId, value.id);
          for (const kind of [
            "deployment.watch",
            "deployment.watch-cadence",
          ] as const) {
            const id = pagingWorkId(base.workspaceId, kind, targetId, value.id);
            await base.work.enqueue("job", {
              id,
              kind,
              idempotencyKey: id,
              priority: 80,
              dueAt:
                kind === "deployment.watch"
                  ? new Date(Date.parse(watch.startedAt) + 60_000).toISOString()
                  : watch.startedAt,
              payload: {
                targetId,
                deploymentId: value.id,
                startedAt: watch.startedAt,
              },
            });
          }
          return true;
        }),
    },
  };
}
