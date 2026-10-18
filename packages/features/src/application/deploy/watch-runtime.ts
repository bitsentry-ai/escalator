import { z } from "zod";
import {
  opaqueIdSchema,
  utcTimestampSchema,
  deploymentWatchReceiptGraceSeconds,
  type DeploymentEntry,
  type DeploymentWatchRecord,
  type DeploymentBaseline,
  type WorkspaceId,
} from "../../contracts/index.js";
import type { WorkLease, WorkResult } from "../jobs/ports.js";
import type { WorkHandlers } from "../jobs/scheduler.js";
import type { WorkHandler } from "../jobs/runner.js";
import type { PagingTransaction } from "../paging/persistence.js";
import { openPageInTransaction } from "../paging/create-page.js";
import { pagingWorkId } from "../paging/work-ids.js";
import type { DeploymentWatchTransaction } from "./watch-persistence.js";
import {
  advanceDeploymentWatch,
  type WatchEvaluationUpdate,
} from "./watch-record.js";
import { watchPagePolicy } from "./watch-page-policy.js";

export const deploymentWatchPayloadSchema = z.strictObject({
  targetId: opaqueIdSchema,
  deploymentId: opaqueIdSchema,
  startedAt: utcTimestampSchema,
});
export const deploymentWatchLane = ["deployment.watch"] as const;
import type { WatchIncidentCorrelation } from "./watch-correlation.js";
export interface WatchRuntimeTransaction
  extends DeploymentWatchTransaction, PagingTransaction {
  watchIncidents: WatchIncidentCorrelation;
  watchEvidence: {
    /** Same physical transaction: lock captured source IDs in byte order before
     * reading bounded historical evidence and overlaps. Never fetch providers.
     * Receipt visibility is capped at endsAt + grace, including delayed workers.
     */
    read(
      entry: DeploymentEntry,
      watch: DeploymentWatchRecord,
      baseline: DeploymentBaseline | undefined,
    ): Promise<WatchEvaluationUpdate>;
  };
}
export interface WatchRuntimeRepository {
  transaction<T>(
    scope: WorkspaceId,
    run: (tx: WatchRuntimeTransaction) => Promise<T>,
  ): Promise<T>;
}
const actor = { kind: "system", component: "deployment-watch" } as const;
const incidentIdFor = (scope: WorkspaceId, deploymentId: string) =>
  pagingWorkId(scope, "deployment-watch-incident", deploymentId);
/** One persisted watch per accepted finish. Evaluation, incident/page, audit and
 * work fencing share one transaction. Provider delivery happens through the outbox.
 */
export class DeploymentWatches {
  constructor(private readonly repository: WatchRuntimeRepository) {}
  run(lease: WorkLease): Promise<WorkResult> {
    const hint = deploymentWatchPayloadSchema.parse(lease.payload);
    return this.repository.transaction(lease.workspaceId, async (tx) => {
      const target = await tx.targets.get(hint.targetId);
      if (!target) throw new Error("Watch target is missing");
      const entry = await tx.deployments.get(target.id, hint.deploymentId);
      const watch = await tx.watches.get(target.id, hint.deploymentId);
      if (!entry || !watch)
        throw new Error("Watch job references missing state");
      const at = utcTimestampSchema.parse(await tx.currentTime());
      // A mis-scheduled job waits rather than interpreting a zero-length window.
      const firstPoll = Date.parse(watch.startedAt) + 60_000;
      const evidence =
        watch.finalizedAt === null && Date.parse(at) >= firstPoll
          ? await tx.watchEvidence.read(
              entry,
              watch,
              await tx.baselines.get(target.id, entry.deployment.id),
            )
          : undefined;
      const next = evidence
        ? advanceDeploymentWatch(watch, evidence)
        : undefined;
      const binding =
        next?.verdict === "FAIL" && watch.incidentId === null
          ? await tx.watchIncidents.lock(next)
          : undefined;
      const incidentId =
        watch.incidentId ??
        binding?.incidentId ??
        incidentIdFor(tx.workspaceId, entry.deployment.id);
      // Lock order: target -> captured sources -> group -> page -> work. Read helpers must
      // not lock work or take the global probe-capacity lock.
      await tx.pages.lock(pagingWorkId(tx.workspaceId, "page", incidentId));
      const claim = await tx.work.lockClaim(lease);
      if (!claim) return { state: "completed" };
      const payload = deploymentWatchPayloadSchema.parse(claim.payload);
      if (
        claim.workspaceId !== tx.workspaceId ||
        claim.queue !== "job" ||
        claim.kind !== "deployment.watch" ||
        claim.id !==
          pagingWorkId(
            tx.workspaceId,
            "deployment.watch",
            target.id,
            entry.deployment.id,
          ) ||
        payload.targetId !== target.id ||
        payload.deploymentId !== entry.deployment.id ||
        payload.startedAt !== watch.startedAt
      )
        throw new Error("Invalid deployment watch claim");
      if (watch.finalizedAt !== null) return { state: "completed" };
      if (!evidence || !next)
        return {
          state: "wait",
          delayMs: Math.max(1, firstPoll - Date.parse(at)),
        };
      let linked = watch.incidentId ?? binding?.incidentId ?? undefined;
      if (next.verdict === "FAIL") {
        if (linked) {
          const incident = await tx.incidents.get(linked);
          const page = await tx.pages.get(
            pagingWorkId(tx.workspaceId, "page", linked),
          );
          if (
            !incident ||
            !page ||
            incident.workspaceId !== tx.workspaceId ||
            incident.serviceId !== watch.serviceId ||
            incident.environmentId !== watch.environmentId ||
            page.incidentId !== incident.id
          )
            throw new Error(
              "Failed watch is missing its scoped incident and page",
            );
          // Acknowledgement/resolution never causes a subsequent sample to repage.
        } else {
          await openPageInTransaction(
            { ...tx, now: evidence.evaluatedAt },
            {
              incident: {
                id: incidentId,
                serviceId: watch.serviceId,
                environmentId: watch.environmentId,
                title: "Post-deployment health watch failed",
                severity: "high",
              },
              policy: watchPagePolicy(entry, next),
            },
            actor,
          );
          linked = incidentId;
        }
        if (binding) await binding.attach(linked);
      }
      const saved = await tx.watches.advance(
        target.id,
        entry.deployment.id,
        watch.revision,
        evidence,
        linked,
      );
      if (!saved) throw new Error("Locked deployment watch changed");
      if (
        saved.verdict !== watch.verdict ||
        saved.finalizedAt !== watch.finalizedAt ||
        saved.incidentId !== watch.incidentId
      ) {
        await tx.audit.append({
          id: pagingWorkId(
            tx.workspaceId,
            "deployment-watch-audit",
            entry.deployment.id,
            String(saved.revision),
          ),
          workspaceId: tx.workspaceId,
          actor,
          action: "deployment.watch_evaluated",
          subjectType: "deployment",
          subjectId: entry.deployment.id,
          recordedAt: evidence.evaluatedAt,
          metadata: {
            targetId: target.id,
            verdict: saved.verdict,
            incidentId: saved.incidentId,
            finalizedAt: saved.finalizedAt,
            inventoryComplete: saved.inventoryComplete,
            overlapInventoryComplete: saved.overlapInventoryComplete,
          },
        });
      }
      if (saved.finalizedAt !== null) return { state: "completed" };
      const finalAt =
        Date.parse(saved.endsAt) + deploymentWatchReceiptGraceSeconds * 1000;
      // Successful waits reset retry attempts in both durable work adapters.
      return {
        state: "wait",
        delayMs: Math.max(
          1,
          Math.min(60_000, finalAt - Date.parse(await tx.currentTime())),
        ),
      };
    });
  }
}
export function withDeploymentWatchHandlers(
  handlers: WorkHandlers,
  repository: WatchRuntimeRepository,
): WorkHandlers {
  if (handlers.job.has("deployment.watch"))
    throw new Error("Watch handler already registered");
  const watches = new DeploymentWatches(repository);
  return {
    job: new Map<string, WorkHandler>([
      ...handlers.job,
      ["deployment.watch", (lease) => watches.run(lease)],
    ]),
    outbox: handlers.outbox,
  };
}
