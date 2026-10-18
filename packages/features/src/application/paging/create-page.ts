import { z } from "zod";
import {
  operationalIncidentSchema,
  operationalPageSchema,
  type WorkspaceId,
  escalationPolicySchema,
  type OperationalPage,
} from "../../contracts/index.js";
import { escalationSteps } from "../../domain/escalation/ladder.js";
import type { AuditActor } from "../ports/audit.js";
import { PersistenceError } from "../ports/persistence.js";
import type { PagingRepository, PagingTransaction } from "./persistence.js";
import { pagingWorkId } from "./work-ids.js";

const openInput = z.strictObject({
  incident: z.strictObject({
    id: operationalIncidentSchema.shape.id,
    serviceId: operationalIncidentSchema.shape.serviceId,
    environmentId: operationalIncidentSchema.shape.environmentId,
    title: operationalIncidentSchema.shape.title,
    severity: operationalIncidentSchema.shape.severity,
  }),
  policy: escalationPolicySchema,
});
export type OpenPageInput = z.infer<typeof openInput>;

class PageContentConflictError extends Error {
  readonly code = "already_exists";
}

function parseInput(scope: WorkspaceId, input: OpenPageInput) {
  const parsed = openInput.parse(input);
  if (
    parsed.policy.workspaceId !== scope ||
    parsed.policy.serviceId !== parsed.incident.serviceId
  )
    throw new PersistenceError("scope_violation");
  return parsed;
}
export async function findExistingPage(
  tx: PagingTransaction,
  incidentInput: OpenPageInput["incident"],
): Promise<OperationalPage | undefined> {
  const pageId = pagingWorkId(tx.workspaceId, "page", incidentInput.id);
  const incident = await tx.incidents.get(incidentInput.id);
  if (!incident) return undefined;
  if (
    incident.serviceId !== incidentInput.serviceId ||
    incident.environmentId !== incidentInput.environmentId ||
    incident.title !== incidentInput.title ||
    incident.severity !== incidentInput.severity
  )
    throw new PageContentConflictError(
      "Incident idempotency key was reused with different content",
    );
  const page = await tx.pages.get(pageId);
  if (!page) throw new Error("Incident is missing its atomic page");
  return page;
}
/** Same transaction as policy selection and caller audit; no provider I/O. */
export async function openPageInTransaction(
  tx: PagingTransaction,
  input: OpenPageInput,
  actor: AuditActor = { kind: "system", component: "paging" },
): Promise<OperationalPage> {
  const scope = tx.workspaceId;
  const parsed = parseInput(scope, input);
  const existing = await findExistingPage(tx, parsed.incident);
  if (existing) return existing;
  const pageId = pagingWorkId(scope, "page", parsed.incident.id);
  const service = await tx.services.get(parsed.incident.serviceId);
  if (!service?.enabled) throw new Error("Service is unavailable for paging");
  const incident = operationalIncidentSchema.parse({
    ...parsed.incident,
    workspaceId: scope,
    openedAt: tx.now,
    resolvedAt: null,
  });
  const page = operationalPageSchema.parse({
    id: pageId,
    workspaceId: scope,
    incidentId: incident.id,
    policy: parsed.policy,
    createdAt: tx.now,
    state: "open",
    revision: 1,
    acknowledgedBy: null,
    acknowledgedAt: null,
    resolvedAt: null,
  });
  await tx.incidents.insert(incident);
  await tx.pages.insert(page);
  for (const step of escalationSteps(page.policy, page.createdAt)) {
    const id = pagingWorkId(scope, "step", page.id, step.id);
    await tx.work.enqueue("job", {
      id,
      kind: "paging.step",
      idempotencyKey: id,
      payload: { pageId: page.id, logicalStepId: step.id },
      dueAt: step.dueAt,
      priority: 100,
    });
  }
  await tx.audit.append({
    id: pagingWorkId(scope, "open-audit", page.id),
    workspaceId: scope,
    actor,
    action: "page.opened",
    subjectType: "page",
    subjectId: page.id,
    recordedAt: tx.now,
    metadata: { incidentId: incident.id },
  });
  return page;
}
/** Called only after host ingress/application authorization. No provider I/O. */
export class PageCreation {
  constructor(private readonly repository: PagingRepository) {}
  async open(
    scope: WorkspaceId,
    input: OpenPageInput,
  ): Promise<OperationalPage> {
    const parsed = parseInput(scope, input);
    try {
      return await this.repository.transaction(scope, (tx) =>
        openPageInTransaction(tx, parsed),
      );
    } catch (error) {
      if (
        !(error instanceof PersistenceError) ||
        error.code !== "already_exists"
      )
        throw error;
      const existing = await this.repository.transaction(scope, (tx) =>
        findExistingPage(tx, parsed.incident),
      );
      if (!existing) throw error;
      return existing;
    }
  }
}
