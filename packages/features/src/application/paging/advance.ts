import { z } from "zod";
import {
  opaqueIdSchema,
  type ResponderId,
  type OperationalPage,
  type PageStep,
  type PagingContact,
  pagingContactSchema,
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
const payloadSchema = z.strictObject({
  pageId: opaqueIdSchema,
  logicalStepId: opaqueIdSchema,
});
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
      const recorded: PageStep[] = [];
      let after: string | undefined;
      do {
        const batch = await tx.steps.forPage(page.id, { limit: 100, after });
        recorded.push(...batch.items);
        after = batch.next ?? undefined;
      } while (after);
      const decision = planEscalation({
        policy: page.policy,
        createdAt: page.createdAt,
        now: tx.now,
        state: page.state,
        recordedStepIds: recorded.map((step) => step.logicalStepId),
      });
      if (decision.kind === "cancel") return { state: "completed" };
      const all = escalationSteps(page.policy, page.createdAt);
      for (const id of decision.skip) {
        const skipped = all.find((step) => step.id === id)!;
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
      if (decision.kind === "dispatch") {
        const step = decision.step;
        const earlier = new Set(
          recorded
            .filter((entry) => Date.parse(entry.dueAt) < Date.parse(step.dueAt))
            .map((entry) => entry.id),
        );
        let cursor: string | undefined;
        do {
          const batch = await tx.deliveries.forPage(page.id, {
            limit: 100,
            after: cursor,
          });
          await cancelDeliveryWork(
            tx,
            batch.items.filter((entry) => earlier.has(entry.stepId)),
          );
          cursor = batch.next ?? undefined;
        } while (cursor);
        const ids = await this.recipients(tx, page, step.target, step.dueAt);
        const routes: { responderId: ResponderId; contact: PagingContact }[] =
          [];
        for (const id of ids) {
          const responder = await tx.responders.get(id);
          if (!responder?.enabled) continue;
          const candidates = (await tx.routing.contacts(id)).map((contact) =>
            pagingContactSchema.parse(contact),
          );
          if (
            candidates.length > 100 ||
            new Set(candidates.map((contact) => contact.id)).size !==
              candidates.length ||
            candidates.some(
              (contact) =>
                contact.workspaceId !== tx.workspaceId ||
                contact.responderId !== id,
            )
          )
            throw new Error("Invalid contact scope");
          const contact = candidates
            .filter((entry) => entry.enabled)
            .sort(
              (a, b) => a.priority - b.priority || (a.id < b.id ? -1 : 1),
            )[0];
          if (contact) routes.push({ responderId: id, contact });
        }
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
        for (const route of routes) {
          const deliveryId = pagingWorkId(
            tx.workspaceId,
            "delivery",
            stepId,
            route.responderId,
          );
          await tx.deliveries.insert({
            id: deliveryId,
            workspaceId: tx.workspaceId,
            pageId: page.id,
            stepId,
            recipientId: route.responderId,
            contactId: route.contact.id,
            channel: route.contact.channel,
            createdAt: tx.now,
          });
          const id = pagingWorkId(tx.workspaceId, "send", deliveryId);
          await tx.work.enqueue("outbox", {
            id,
            kind: "paging.send",
            idempotencyKey: id,
            payload: {
              pageId: page.id,
              deliveryId,
              secretId: route.contact.secretId,
              approvedSecretIds: [route.contact.secretId],
            },
            dueAt: tx.now,
          });
        }
      }
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
  private async recipients(
    tx: DispatchTransaction,
    page: OperationalPage,
    target: "primary" | "peer" | "fallback" | "operator",
    at: string,
  ): Promise<ResponderId[]> {
    if (target === "fallback") return page.policy.fallbackResponderIds;
    if (target === "operator") return page.policy.terminal.notifyResponderIds;
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
