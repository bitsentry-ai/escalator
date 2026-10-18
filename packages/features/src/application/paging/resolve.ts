import type { OperationalPage } from "../../contracts/index.js";
import { opaqueIdSchema } from "../../contracts/index.js";
import type { AuditActor } from "../ports/audit.js";
import type { PagingTransaction } from "./persistence.js";
import { PersistenceError } from "../ports/persistence.js";
import { cancelPageWork } from "./cancel.js";
import { pagingWorkId } from "./work-ids.js";

/** Page, incident, cancellation intents and audit share one transaction. */
export async function resolvePageInTransaction(
  tx: PagingTransaction,
  incidentId: string,
  actor: AuditActor,
): Promise<OperationalPage> {
  opaqueIdSchema.parse(incidentId);
  const page = await tx.pages.lock(
    pagingWorkId(tx.workspaceId, "page", incidentId),
  );
  if (!page || page.incidentId !== incidentId)
    throw new PersistenceError("not_found");
  if (page.state === "resolved") return page;
  const at = new Date(
    Math.max(
      Date.parse(tx.now),
      Date.parse(page.acknowledgedAt ?? page.createdAt),
    ),
  ).toISOString();
  const resolved: OperationalPage = {
    ...page,
    state: "resolved",
    resolvedAt: at,
    revision: page.revision + 1,
  };
  if (!(await tx.pages.replace(resolved, page.revision)))
    throw new Error("Locked page revision changed");
  await tx.incidents.resolve(incidentId, page.id);
  await cancelPageWork(tx, resolved);
  await tx.audit.append({
    id: pagingWorkId(tx.workspaceId, "resolve-audit", page.id),
    workspaceId: tx.workspaceId,
    actor,
    action: "incident.resolved",
    subjectType: "incident",
    subjectId: incidentId,
    recordedAt: at,
    metadata: {},
  });
  return resolved;
}
