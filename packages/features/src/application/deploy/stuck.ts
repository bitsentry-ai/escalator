import { z } from "zod";
import {
  opaqueIdSchema,
  utcTimestampSchema,
  deploymentEntrySchema,
  type WorkspaceId,
} from "../../contracts/index.js";
import { timeoutDeployment } from "../../domain/deploy/lifecycle.js";
import type { WorkLease, WorkResult } from "../jobs/ports.js";
import type { WorkHandlers } from "../jobs/scheduler.js";
import type { WorkHandler } from "../jobs/runner.js";
import type { PagingTransaction } from "../paging/persistence.js";
import {
  openPageInTransaction,
  findExistingPage,
} from "../paging/create-page.js";
import { pagingWorkId } from "../paging/work-ids.js";
import type { DeploymentTransaction } from "./ports.js";
import type { TransactionGuard } from "../ports/transaction-guard.js";
import { stuckDeploymentPolicy } from "./stuck-policy.js";

export interface StuckDeploymentTransaction
  extends DeploymentTransaction, PagingTransaction {}
export interface StuckDeploymentRepository {
  transaction<T>(
    scope: WorkspaceId,
    run: (tx: StuckDeploymentTransaction) => Promise<T>,
  ): Promise<T>;
}
const payloadSchema = z.strictObject({
  targetId: opaqueIdSchema,
  deploymentId: opaqueIdSchema,
  timeoutAt: utcTimestampSchema,
});
export const deploymentTimeoutLane = ["deployment.timeout"] as const;
/** Hosts apply this decorator on the same physical transaction as start/receipt/audit.
 * Domain inserts and the job commit or roll back together; no after-commit scheduling.
 */
export function withDeploymentTimeout<Tx extends DeploymentTransaction>(
  tx: Tx,
  guard: TransactionGuard,
): Tx {
  return {
    ...tx,
    deployments: {
      ...tx.deployments,
      insert: (raw) =>
        guard.operation(async () => {
          const entry = deploymentEntrySchema.parse(raw);
          await tx.deployments.insert(entry);
          const id = pagingWorkId(
            tx.workspaceId,
            "deployment.timeout",
            entry.targetId,
            entry.deployment.id,
          );
          await tx.work.enqueue("job", {
            id,
            kind: "deployment.timeout",
            idempotencyKey: id,
            priority: 90,
            dueAt: entry.deployment.timeoutAt,
            payload: {
              targetId: entry.targetId,
              deploymentId: entry.deployment.id,
              timeoutAt: entry.deployment.timeoutAt,
            },
          });
        }),
    },
  };
}
/** Host adapters must compose deployment and paging ports on one guarded connection. */
export class StuckDeployments {
  constructor(private readonly repository: StuckDeploymentRepository) {}
  run(lease: WorkLease): Promise<WorkResult> {
    const hint = payloadSchema.parse(lease.payload);
    return this.repository.transaction(lease.workspaceId, async (tx) => {
      const target = await tx.targets.get(hint.targetId);
      if (!target) throw new Error("Timeout target is missing");
      const entry = await tx.deployments.get(target.id, hint.deploymentId);
      if (!entry) throw new Error("Timeout deployment is missing");
      const incidentId = pagingWorkId(
        tx.workspaceId,
        "deployment-timeout-incident",
        entry.deployment.id,
      );
      // Lock order: target, existing page, then work. Matches paging's page -> work order.
      await tx.pages.lock(pagingWorkId(tx.workspaceId, "page", incidentId));
      const claim = await tx.work.lockClaim(lease);
      if (!claim) return { state: "completed" };
      const payload = payloadSchema.parse(claim.payload);
      if (
        claim.queue !== "job" ||
        claim.kind !== "deployment.timeout" ||
        claim.workspaceId !== tx.workspaceId ||
        claim.id !==
          pagingWorkId(
            tx.workspaceId,
            "deployment.timeout",
            target.id,
            entry.deployment.id,
          ) ||
        payload.targetId !== target.id ||
        payload.deploymentId !== entry.deployment.id ||
        payload.timeoutAt !== entry.deployment.timeoutAt
      )
        throw new Error("Invalid deployment timeout claim");
      const at = await tx.currentTime();
      const decision = timeoutDeployment(entry.deployment, at);
      const incident = {
        id: incidentId,
        serviceId: entry.deployment.serviceId,
        environmentId: entry.deployment.environmentId,
        title: "Deployment exceeded its deadline",
        severity: "high" as const,
      };
      if (decision.state === "unchanged") {
        if (
          entry.deployment.status === "TIMED_OUT" &&
          !(await findExistingPage(tx, incident))
        )
          throw new Error("Timed-out deployment is missing its atomic page");
        return { state: "completed" };
      }
      if (decision.state === "wait")
        return {
          state: "wait",
          delayMs: Math.max(
            1,
            Math.min(3600000, Date.parse(decision.dueAt) - Date.parse(at)),
          ),
        };
      if (decision.state !== "changed")
        throw new Error("Invalid deployment timeout chronology");
      if (
        !(await tx.deployments.replace(
          target.id,
          decision.deployment,
          entry.deployment.revision,
        ))
      )
        throw new Error("Locked deployment changed");
      const page = await openPageInTransaction(
        { ...tx, now: at },
        { incident, policy: stuckDeploymentPolicy(entry) },
        { kind: "system", component: "deployment-timeout" },
      );
      await tx.audit.append({
        id: pagingWorkId(
          tx.workspaceId,
          "deployment-timeout-audit",
          entry.deployment.id,
        ),
        workspaceId: tx.workspaceId,
        actor: { kind: "system", component: "deployment-timeout" },
        action: "deployment.timed_out",
        subjectType: "deployment",
        subjectId: entry.deployment.id,
        recordedAt: at,
        metadata: {
          targetId: target.id,
          incidentId,
          pageId: page.id,
          mappedDeployerId: entry.deployment.mappedDeployerId,
        },
      });
      return { state: "completed" };
    });
  }
}
export function withDeploymentTimeoutHandlers(
  handlers: WorkHandlers,
  repository: StuckDeploymentRepository,
): WorkHandlers {
  if (handlers.job.has("deployment.timeout"))
    throw new Error("Deployment timeout handler already registered");
  const jobs = new StuckDeployments(repository);
  return {
    job: new Map<string, WorkHandler>([
      ...handlers.job,
      ["deployment.timeout", (lease) => jobs.run(lease)],
    ]),
    outbox: handlers.outbox,
  };
}
