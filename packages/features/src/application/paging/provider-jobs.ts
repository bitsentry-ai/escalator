import { z } from "zod";
import {
  opaqueIdSchema,
  utcTimestampSchema,
  type RecipientDelivery,
} from "../../contracts/index.js";
import type {
  ReceiptChannel,
  ChannelReceiptResult,
} from "../../adapters/channels/ports.js";
import { escalationSteps } from "../../domain/escalation/ladder.js";
import type { WorkLease } from "../jobs/ports.js";
import { retryDelay, type WorkHandlerResult } from "../jobs/runner.js";
import type { PagingRepository, PagingTransaction } from "./persistence.js";
import { acknowledgePageInTransaction } from "./acknowledge.js";
import { cancelDeliveryWork } from "./cancel.js";
import { pagingWorkId } from "./work-ids.js";
import { expectDefined } from "../../contracts/expect-defined.js";
import type { WorkspaceId } from "../../contracts/identity.js";
const common = {
  pageId: opaqueIdSchema,
  deliveryId: opaqueIdSchema,
  secretId: opaqueIdSchema,
  approvedSecretIds: z.array(opaqueIdSchema).length(1),
};
const pollPayload = z.strictObject({
  ...common,
  attemptId: opaqueIdSchema,
  receiptId: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9._:-]+$/),
  pollUntil: utcTimestampSchema,
});
const cancelPayload = z.strictObject({
  ...common,
  attemptId: opaqueIdSchema.optional(),
});
/** The job id a claim must carry; a receipt job without an attempt matches no claim. */
function expectedClaimId(
  workspaceId: WorkspaceId,
  mode: "receipt" | "cancel",
  payload: { deliveryId: string; attemptId?: string },
): string | undefined {
  if (mode === "receipt")
    return payload.attemptId
      ? pagingWorkId(
          workspaceId,
          "receipt",
          payload.deliveryId,
          payload.attemptId,
        )
      : undefined;
  if (payload.attemptId)
    return pagingWorkId(
      workspaceId,
      "cancel-after",
      payload.deliveryId,
      payload.attemptId,
    );
  return pagingWorkId(workspaceId, "cancel", payload.deliveryId);
}
interface Prepared {
  lease: WorkLease;
  delivery: RecipientDelivery;
  secretId: string;
  receiptId?: string;
  pollUntil?: string;
}
export class PagingProviderJobs {
  constructor(
    private readonly repository: PagingRepository,
    private readonly channel: ReceiptChannel,
    private readonly random = Math.random,
  ) {}
  private async prepare(
    lease: WorkLease,
    mode: "receipt" | "cancel",
  ): Promise<Prepared | WorkHandlerResult> {
    const schema = mode === "receipt" ? pollPayload : cancelPayload;
    const hint = schema.parse(lease.payload);
    return this.repository.transaction(lease.workspaceId, async (tx) => {
      const page = await tx.pages.lock(hint.pageId);
      const claimed = await tx.work.lockClaim(lease);
      if (!claimed) return { state: "stale" };
      const payload = schema.parse(claimed.payload);
      const delivery = await tx.deliveries.get(payload.deliveryId);
      const expected = expectedClaimId(tx.workspaceId, mode, payload);
      if (
        !page ||
        payload.pageId !== page.id ||
        !delivery ||
        delivery.pageId !== page.id ||
        delivery.channel !== "pushover" ||
        delivery.secretId !== payload.secretId ||
        payload.approvedSecretIds[0] !== payload.secretId ||
        claimed.queue !== "job" ||
        claimed.kind !== `paging.${mode}` ||
        claimed.id !== expected
      )
        throw new Error("Invalid provider job claim");
      const attempt = payload.attemptId
        ? await tx.attempts.get(payload.attemptId)
        : undefined;
      if (payload.attemptId && (!attempt || attempt.deliveryId !== delivery.id))
        throw new Error("Invalid provider attempt");
      if (mode === "cancel") {
        if (!(await this.closed(tx, page.id, delivery)))
          throw new Error("Cannot cancel an active delivery");
        return { lease: claimed, delivery, secretId: payload.secretId };
      }
      if (page.state === "acknowledged" || page.state === "resolved") {
        await cancelDeliveryWork(tx, [delivery]);
        return { state: "stale" };
      }
      const polling = pollPayload.parse(payload);
      if (Date.parse(polling.pollUntil) - Date.parse(tx.now) > 604_800_000)
        throw new Error("Receipt polling deadline exceeds retention window");
      // The immutable intent is written atomically with either accepted attempt
      // storage or late-result audit. Recovery can already have made the latter unknown.
      if (
        !attempt ||
        !["accepted", "unknown"].includes(attempt.outcome) ||
        (attempt.outcome === "accepted" &&
          attempt.providerReceiptId !== polling.receiptId)
      )
        throw new Error("Missing accepted receipt");
      if (Date.parse(tx.now) >= Date.parse(polling.pollUntil))
        return { state: "completed" };
      return {
        lease: claimed,
        delivery,
        secretId: payload.secretId,
        receiptId: polling.receiptId,
        pollUntil: polling.pollUntil,
      };
    });
  }
  private async closed(
    tx: PagingTransaction,
    pageId: string,
    delivery: RecipientDelivery,
  ): Promise<boolean> {
    const page = expectDefined(await tx.pages.get(pageId), "page");
    if (page.state === "acknowledged" || page.state === "resolved") return true;
    const step = await tx.steps.get(delivery.stepId);
    if (!step) throw new Error("Invalid delivery deadline");
    const steps = escalationSteps(page.policy, page.createdAt);
    const index = steps.findIndex((s) => s.id === step.logicalStepId);
    if (index < 0) throw new Error("Invalid delivery deadline");
    const next = steps[index + 1]?.dueAt;
    if (next !== undefined && Date.parse(tx.now) >= Date.parse(next))
      return true;
    // A clock rewind cannot reactivate a delivery already superseded durably.
    let after: string | undefined;
    do {
      const batch = await tx.steps.forPage(page.id, { limit: 100, after });
      if (
        batch.items.some(
          (entry) => Date.parse(entry.dueAt) > Date.parse(step.dueAt),
        )
      )
        return true;
      after = batch.next ?? undefined;
    } while (after);
    return false;
  }
  async cancel(
    lease: WorkLease,
    signal: AbortSignal,
  ): Promise<WorkHandlerResult> {
    const prepared = await this.prepare(lease, "cancel");
    if (!("delivery" in prepared)) return prepared;
    let result: "cancelled" | "unknown";
    try {
      result = await this.channel.cancel(
        prepared.delivery.id,
        this.use(prepared, signal),
      );
    } catch {
      result = "unknown";
    }
    return result === "cancelled"
      ? { state: "completed" }
      : this.retry(prepared.lease);
  }
  async poll(
    lease: WorkLease,
    signal: AbortSignal,
  ): Promise<WorkHandlerResult> {
    const prepared = await this.prepare(lease, "receipt");
    if (!("delivery" in prepared)) return prepared;
    // A prepared receipt job always carries its receipt and polling deadline.
    const receiptId = expectDefined(prepared.receiptId, "receipt id");
    const pollUntil = expectDefined(prepared.pollUntil, "receipt deadline");
    let result: ChannelReceiptResult;
    try {
      result = await this.channel.inspect(
        receiptId,
        this.use(prepared, signal),
      );
    } catch {
      result = { state: "unknown" };
    }
    return this.repository.transaction(lease.workspaceId, async (tx) => {
      const page = await tx.pages.lock(prepared.delivery.pageId);
      const current = await tx.work.lockClaim(prepared.lease);
      if (!page || !current) return { state: "stale" };
      if (page.state === "acknowledged" || page.state === "resolved") {
        await cancelDeliveryWork(tx, [prepared.delivery]);
        return { state: "stale" };
      }
      if (Date.parse(tx.now) >= Date.parse(pollUntil))
        return { state: "completed" };
      if (result.state === "acknowledged") {
        utcTimestampSchema.parse(result.acknowledgedAt);
        await acknowledgePageInTransaction(
          tx,
          page,
          prepared.delivery.recipientId,
          { kind: "system", component: "paging-receipt" },
        );
        return { state: "completed" };
      }
      if (result.state === "unknown") return this.retry(current);
      // Pushover stops prompting for acknowledgement once a receipt expires.
      if (result.state === "expired") return { state: "completed" };
      return {
        state: "wait",
        delayMs: Math.max(
          1,
          Math.min(5000, Date.parse(pollUntil) - Date.parse(tx.now)),
        ),
      };
    });
  }
  private use(prepared: Prepared, signal: AbortSignal) {
    return {
      workspaceId: prepared.lease.workspaceId,
      secretId: prepared.secretId,
      queue: "job" as const,
      workId: prepared.lease.id,
      claimToken: prepared.lease.token,
      signal,
    };
  }
  private retry(lease: WorkLease): WorkHandlerResult {
    return {
      state: "retry",
      delayMs: Math.max(
        5000,
        retryDelay(lease.attempt, {
          retryBaseMs: 5000,
          retryMaxMs: 60000,
          random: this.random,
        }),
      ),
    };
  }
}
