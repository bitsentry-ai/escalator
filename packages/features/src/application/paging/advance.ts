import { z } from "zod";
import {
  opaqueIdSchema,
  type ResponderId,
  type OperationalPage,
  type PageStep,
  type PagingContact,
  pagingContactSchema,
  hasCapability,
  type EscalationStep,
} from "../../contracts/index.js";
import { resolveSchedule } from "../../domain/schedule/resolve.js";
import {
  escalationSteps,
  planEscalation,
} from "../../domain/escalation/ladder.js";
import type { WorkLease, WorkResult } from "../jobs/ports.js";
import type { DispatchRepository, DispatchTransaction } from "./routing.js";
import { pagingWorkId } from "./work-ids.js";
import { cancelDeliveryWork } from "./cancel.js";
import { expectDefined } from "../../contracts/expect-defined.js";
const payloadSchema = z.strictObject({
  pageId: opaqueIdSchema,
  logicalStepId: opaqueIdSchema,
});
async function recordedSteps(
  tx: DispatchTransaction,
  pageId: string,
): Promise<PageStep[]> {
  const recorded: PageStep[] = [];
  let after: string | undefined;
  do {
    const batch = await tx.steps.forPage(pageId, { limit: 100, after });
    recorded.push(...batch.items);
    after = batch.next ?? undefined;
  } while (after);
  return recorded;
}
async function recordSkippedSteps(
  tx: DispatchTransaction,
  page: OperationalPage,
  skip: readonly string[],
): Promise<void> {
  const all = escalationSteps(page.policy, page.createdAt);
  for (const id of skip) {
    const skipped = expectDefined(
      all.find((step) => step.id === id),
      "skipped escalation step",
    );
    await tx.steps.insert({
      id: pagingWorkId(tx.workspaceId, "step-record", page.id, id),
      workspaceId: tx.workspaceId,
      pageId: page.id,
      logicalStepId: id,
      dueAt: skipped.dueAt,
      recordedAt: tx.now,
      disposition: "skipped",
      recipientIds: [],
    });
  }
}
/** Stops deliveries of earlier steps; a later escalation supersedes them. */
async function cancelEarlierDeliveries(
  tx: DispatchTransaction,
  pageId: string,
  recorded: readonly PageStep[],
  dueAt: string,
): Promise<void> {
  const earlier = new Set(
    recorded
      .filter((entry) => Date.parse(entry.dueAt) < Date.parse(dueAt))
      .map((entry) => entry.id),
  );
  let cursor: string | undefined;
  do {
    const batch = await tx.deliveries.forPage(pageId, {
      limit: 100,
      after: cursor,
    });
    await cancelDeliveryWork(
      tx,
      batch.items.filter((entry) => earlier.has(entry.stepId)),
      false,
    );
    cursor = batch.next ?? undefined;
  } while (cursor);
}
async function enqueueDelivery(
  tx: DispatchTransaction,
  pageId: string,
  stepId: string,
  route: { responderId: ResponderId; contact: PagingContact },
): Promise<void> {
  const deliveryId = pagingWorkId(
    tx.workspaceId,
    "delivery",
    stepId,
    route.responderId,
  );
  await tx.deliveries.insert({
    id: deliveryId,
    workspaceId: tx.workspaceId,
    pageId,
    stepId,
    recipientId: route.responderId,
    contactId: route.contact.id,
    secretId: route.contact.secretId,
    channel: route.contact.channel,
    createdAt: tx.now,
  });
  const id = pagingWorkId(tx.workspaceId, "send", deliveryId);
  await tx.work.enqueue("outbox", {
    id,
    kind: "paging.send",
    idempotencyKey: id,
    payload: {
      pageId,
      deliveryId,
      secretId: route.contact.secretId,
      approvedSecretIds: [route.contact.secretId],
    },
    dueAt: tx.now,
  });
}
/**
 * The responder's parsed, distinct contacts. A contact from another workspace or responder is corrupt data and fails
 * the step; an unreadable or duplicate one is skipped with an audit record.
 */
async function validContacts(
  tx: DispatchTransaction,
  id: ResponderId,
  stepWorkId: string,
): Promise<PagingContact[]> {
  const candidates: PagingContact[] = [];
  const seen = new Set<string>();
  let index = 0;
  for (const raw of await tx.routing.contacts(id)) {
    index++;
    const parsed = pagingContactSchema.strip().safeParse(raw);
    // A contact from another workspace or responder is corrupt data: fail the step loudly.
    if (
      parsed.success &&
      (parsed.data.workspaceId !== tx.workspaceId ||
        parsed.data.responderId !== id)
    )
      throw new Error("Invalid contact scope");
    if (!parsed.success || seen.has(parsed.data.id)) {
      await tx.audit.append({
        id: pagingWorkId(
          tx.workspaceId,
          "invalid-contact",
          stepWorkId,
          id,
          String(index),
        ),
        workspaceId: tx.workspaceId,
        actor: { kind: "system", component: "paging" },
        action: "paging.contact_skipped",
        subjectType: "responder",
        subjectId: id,
        recordedAt: tx.now,
        metadata: { reason: "invalid_contact" },
      });
      continue;
    }
    seen.add(parsed.data.id);
    candidates.push(parsed.data);
  }
  return candidates;
}
/** Each scheduled deadline is independent of provider retries. */
export class PageAdvancement {
  constructor(private readonly repository: DispatchRepository) {}
  async advance(lease: WorkLease): Promise<WorkResult> {
    const hint = payloadSchema.parse(lease.payload);
    return this.repository.transaction(lease.workspaceId, async (tx) => {
      const page = await tx.pages.lock(hint.pageId);
      if (!page) throw new Error("Paging job references a missing page");
      const claimed = await tx.work.lockClaim(lease);
      if (!claimed) return { state: "completed" };
      const payload = payloadSchema.parse(claimed.payload);
      const expected = escalationSteps(page.policy, page.createdAt).find(
        (step) => step.id === payload.logicalStepId,
      );
      if (
        claimed.queue !== "job" ||
        claimed.kind !== "paging.step" ||
        payload.pageId !== page.id ||
        !expected ||
        claimed.id !==
          pagingWorkId(tx.workspaceId, "step", page.id, expected.id)
      )
        throw new Error("Invalid paging claim");
      const recorded = await recordedSteps(tx, page.id);
      const decision = planEscalation({
        policy: page.policy,
        createdAt: page.createdAt,
        now: tx.now,
        state: page.state,
        recordedStepIds: recorded.map((step) => step.logicalStepId),
      });
      if (decision.kind === "cancel") return { state: "completed" };
      await recordSkippedSteps(tx, page, decision.skip);
      if (decision.kind === "dispatch")
        await this.dispatchStep(tx, page, decision.step, recorded, lease.id);
      if (
        decision.kind === "wait" &&
        !recorded.some((step) => step.logicalStepId === expected.id) &&
        Date.parse(expected.dueAt) > Date.parse(tx.now)
      ) {
        return {
          state: "retry",
          delayMs: Math.min(
            3_600_000,
            Math.max(1, Date.parse(expected.dueAt) - Date.parse(tx.now)),
          ),
        };
      }
      if (decision.exhausted && page.state === "open") {
        if (
          !(await tx.pages.replace(
            { ...page, state: "exhausted", revision: page.revision + 1 },
            page.revision,
          ))
        )
          throw new Error("Locked page revision changed");
      }
      return { state: "completed" };
    });
  }
  /** Records a dispatched step and queues one delivery per routable recipient. */
  private async dispatchStep(
    tx: DispatchTransaction,
    page: OperationalPage,
    step: EscalationStep,
    recorded: readonly PageStep[],
    leaseId: string,
  ): Promise<void> {
    await cancelEarlierDeliveries(tx, page.id, recorded, step.dueAt);
    const ids = await this.recipients(tx, page, step.target, step.dueAt);
    const requireAck =
      "deployment" in page.policy && step.target !== "operator";
    let routes = await this.routes(tx, ids, requireAck, leaseId);
    // No usable mapped contact: do not wait for the independent fallback deadline.
    if (step.target === "deployer" && routes.length === 0)
      routes = await this.routes(
        tx,
        page.policy.fallbackResponderIds,
        true,
        `${leaseId}:fallback`,
      );
    const stepId = pagingWorkId(
      tx.workspaceId,
      "step-record",
      page.id,
      step.id,
    );
    await tx.steps.insert({
      id: stepId,
      workspaceId: tx.workspaceId,
      pageId: page.id,
      logicalStepId: step.id,
      dueAt: step.dueAt,
      recordedAt: tx.now,
      disposition: routes.length ? "dispatch" : "uncovered",
      recipientIds: routes.map((route) => route.responderId),
    });
    for (const route of routes)
      await enqueueDelivery(tx, page.id, stepId, route);
  }
  private async routes(
    tx: DispatchTransaction,
    ids: readonly ResponderId[],
    requireAck: boolean,
    stepWorkId: string,
  ): Promise<{ responderId: ResponderId; contact: PagingContact }[]> {
    const routes: { responderId: ResponderId; contact: PagingContact }[] = [];
    for (const id of ids) {
      const responder = await tx.responders.get(id);
      if (!responder?.enabled) continue;
      if (requireAck && !hasCapability(responder.role, "incident:acknowledge"))
        continue;
      const candidates = await validContacts(tx, id, stepWorkId);
      const contact = candidates
        .filter((entry) => entry.enabled)
        .sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : 1))[0];
      if (contact) routes.push({ responderId: id, contact });
    }
    return routes;
  }
  private async recipients(
    tx: DispatchTransaction,
    page: OperationalPage,
    target: EscalationStep["target"],
    at: string,
  ): Promise<ResponderId[]> {
    if (target === "fallback") return page.policy.fallbackResponderIds;
    if (target === "operator") return page.policy.terminal.notifyResponderIds;
    if (target === "deployer") {
      if (!("deployment" in page.policy))
        throw new Error("Missing deployment routing context");
      const id = page.policy.deployment.mappedDeployerId;
      return id === null ? [] : [id];
    }
    if ("deployment" in page.policy)
      throw new Error("Unexpected scheduled deployment route");
    const id =
      target === "primary"
        ? page.policy.primaryScheduleId
        : page.policy.peerScheduleId;
    const schedule = await tx.routing.schedule(id);
    if (!schedule) return [];
    if (
      schedule.workspaceId !== tx.workspaceId ||
      schedule.serviceId !== page.policy.serviceId ||
      schedule.id !== id
    )
      throw new Error("Invalid schedule scope");
    const assignment = resolveSchedule(schedule, at);
    return assignment ? [assignment.responderId] : [];
  }
}
