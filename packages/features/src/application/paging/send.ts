import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  deliveryAttemptSchema,
  opaqueIdSchema,
  type DeliveryAttempt,
  type RecipientDelivery,
} from "../../contracts/index.js";
import type {
  ChannelNotification,
  ChannelSendResult,
  NotificationChannel,
} from "../../adapters/channels/ports.js";
import { escalationSteps } from "../../domain/escalation/ladder.js";
import type { WorkLease } from "../jobs/ports.js";
import { retryDelay, type WorkHandlerResult } from "../jobs/runner.js";
import type { PagingRepository, PagingTransaction } from "./persistence.js";
import { pagingWorkId } from "./work-ids.js";
import { acknowledgementDigest } from "./acknowledge.js";
import { cancelDeliveryWork } from "./cancel.js";
import { expectDefined } from "../../contracts/expect-defined.js";
function attemptOutcome(outcome: string): "accepted" | "failed" | "unknown" {
  if (outcome === "accepted") return "accepted";
  if (outcome === "rejected") return "failed";
  return "unknown";
}
const payloadSchema = z.strictObject({
  pageId: opaqueIdSchema,
  deliveryId: opaqueIdSchema,
  secretId: opaqueIdSchema,
  approvedSecretIds: z.array(opaqueIdSchema).length(1),
});
export type PagingChannelFactory = (
  channel: RecipientDelivery["channel"],
  expireSeconds: number,
) => NotificationChannel | undefined;
interface Prepared {
  delivery: RecipientDelivery;
  attempt: DeliveryAttempt;
  secretId: string;
  notification: ChannelNotification;
  expireSeconds: number;
}
/** Commits attempt and digest grant before I/O; provider results survive cancellation. */
export class PageDelivery {
  private readonly base: URL;
  constructor(
    private readonly repository: PagingRepository,
    private readonly channels: PagingChannelFactory,
    baseUrl: string,
    private readonly ackTtlMs = 86_400_000,
    private readonly random = Math.random,
  ) {
    this.base = new URL(baseUrl);
    // Links carry acknowledgement tokens: plain HTTP only on loopback, as for sessions.
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
      this.base.hostname,
    );
    if (
      !(
        this.base.protocol === "https:" ||
        (this.base.protocol === "http:" && loopback)
      ) ||
      this.base.username ||
      this.base.password ||
      this.base.search ||
      this.base.hash ||
      baseUrl.length > 256 ||
      !Number.isSafeInteger(ackTtlMs) ||
      ackTtlMs < 60_000 ||
      ackTtlMs > 604_800_000
    )
      throw new Error("Invalid acknowledgement configuration");
    if (!this.base.pathname.endsWith("/")) this.base.pathname += "/";
  }
  async send(
    lease: WorkLease,
    signal: AbortSignal,
  ): Promise<WorkHandlerResult> {
    const prepared = await this.prepare(lease);
    if (!("delivery" in prepared)) return prepared;
    let result: ChannelSendResult;
    try {
      const channel = this.channels(
        prepared.delivery.channel,
        prepared.expireSeconds,
      );
      result = channel
        ? await channel.send(prepared.notification, {
            workspaceId: lease.workspaceId,
            secretId: prepared.secretId,
            queue: "outbox",
            workId: lease.id,
            claimToken: lease.token,
            signal,
          })
        : {
            outcome: "rejected",
            retryable: false,
            reason: "invalid_configuration",
          };
    } catch {
      result = { outcome: "unknown", retryable: true };
    }
    return this.finish(lease, prepared, result);
  }
  private async prepare(
    lease: WorkLease,
  ): Promise<Prepared | WorkHandlerResult> {
    const hint = payloadSchema.parse(lease.payload);
    return this.repository.transaction(lease.workspaceId, async (tx) => {
      const page = await tx.pages.lock(hint.pageId);
      const claimed = await tx.work.lockClaim(lease);
      if (!claimed) return { state: "stale" };
      const payload = payloadSchema.parse(claimed.payload);
      if (
        !page ||
        payload.pageId !== page.id ||
        claimed.queue !== "outbox" ||
        claimed.kind !== "paging.send" ||
        claimed.id !==
          pagingWorkId(tx.workspaceId, "send", payload.deliveryId) ||
        payload.approvedSecretIds[0] !== payload.secretId
      )
        throw new Error("Invalid delivery claim");
      const delivery = await tx.deliveries.get(payload.deliveryId);
      const step = delivery && (await tx.steps.get(delivery.stepId));
      if (
        !delivery ||
        !step ||
        delivery.pageId !== page.id ||
        delivery.secretId !== payload.secretId
      )
        throw new Error("Invalid delivery reference");
      const steps = escalationSteps(page.policy, page.createdAt);
      const index = steps.findIndex((entry) => entry.id === step.logicalStepId);
      if (index < 0 || steps[index].dueAt !== step.dueAt)
        throw new Error("Invalid delivery deadline");
      const nextAt = steps[index + 1]?.dueAt;
      if (
        page.state === "acknowledged" ||
        page.state === "resolved" ||
        (nextAt && Date.parse(nextAt) <= Date.parse(tx.now))
      ) {
        await cancelDeliveryWork(tx, [delivery], false);
        return { state: "stale" };
      }
      const attempts: DeliveryAttempt[] = [];
      let after: string | undefined;
      do {
        const batch = await tx.attempts.forDelivery(delivery.id, {
          limit: 100,
          after,
        });
        attempts.push(...batch.items);
        after = batch.next ?? undefined;
      } while (after);
      const accepted = attempts.find((entry) => entry.outcome === "accepted");
      if (accepted)
        return {
          state: "completed",
          outcome: "accepted",
          ...(accepted.providerReceiptId
            ? { receipt: accepted.providerReceiptId }
            : {}),
        };
      if (attempts.some((entry) => entry.claimToken === claimed.token))
        return { state: "stale" };
      if (
        attempts.some((entry) => entry.outcome === "failed" && !entry.retryable)
      )
        return { state: "failed", outcome: "rejected" };
      for (const prior of attempts.filter(
        (entry) => entry.outcome === "in_flight",
      ))
        await tx.attempts.finish({
          ...prior,
          outcome: "unknown",
          finishedAt: this.finishedAt(tx, prior),
          retryable: true,
        });
      const attempt = deliveryAttemptSchema.parse({
        id: pagingWorkId(
          tx.workspaceId,
          "attempt",
          delivery.id,
          String(claimed.attempt),
        ),
        workspaceId: tx.workspaceId,
        deliveryId: delivery.id,
        attempt: claimed.attempt,
        claimToken: claimed.token,
        startedAt: tx.now,
        finishedAt: null,
        outcome: "in_flight",
        providerReceiptId: null,
        completedAfterAcknowledgement: false,
      });
      await tx.attempts.insert(attempt);
      const token = randomBytes(32).toString("base64url");
      await tx.grants.insert({
        id: pagingWorkId(tx.workspaceId, "grant", attempt.id),
        workspaceId: tx.workspaceId,
        pageId: page.id,
        recipientId: delivery.recipientId,
        attemptId: attempt.id,
        tokenDigest: expectDefined(
          acknowledgementDigest(token),
          "token digest",
        ),
        createdAt: tx.now,
        expiresAt: new Date(Date.parse(tx.now) + this.ackTtlMs).toISOString(),
      });
      const incident = await tx.incidents.get(page.incidentId);
      if (!incident) throw new Error("Missing incident");
      const url = new URL(
        `ack/${encodeURIComponent(tx.workspaceId)}`,
        this.base,
      );
      url.hash = `token=${token}`;
      return {
        delivery,
        attempt,
        secretId: payload.secretId,
        notification: {
          deliveryId: delivery.id,
          title: incident.title.slice(0, 250),
          message: incident.title,
          acknowledgementUrl: url.toString(),
        },
        expireSeconds: Math.min(
          10800,
          Math.max(
            1,
            Math.floor(
              nextAt ? (Date.parse(nextAt) - Date.parse(tx.now)) / 1000 : 120,
            ),
          ),
        ),
      };
    });
  }
  private finishedAt(tx: PagingTransaction, attempt: DeliveryAttempt): string {
    return new Date(
      Math.max(Date.parse(tx.now), Date.parse(attempt.startedAt)),
    ).toISOString();
  }
  private async finish(
    lease: WorkLease,
    prepared: Prepared,
    result: ChannelSendResult,
  ): Promise<WorkHandlerResult> {
    return this.repository.transaction(lease.workspaceId, async (tx) => {
      const page = await tx.pages.lock(prepared.delivery.pageId);
      if (!page) throw new Error("Missing page");
      const outcome = attemptOutcome(result.outcome);
      const candidate = deliveryAttemptSchema.safeParse({
        ...prepared.attempt,
        outcome,
        finishedAt: this.finishedAt(tx, prepared.attempt),
        providerReceiptId:
          result.outcome === "accepted" ? result.receiptId : null,
        completedAfterAcknowledgement: page.acknowledgedBy !== null,
        retryable: result.outcome !== "accepted" && result.retryable,
        failureReason: result.outcome === "rejected" ? result.reason : null,
      });
      const finished = candidate.success
        ? candidate.data
        : {
            ...prepared.attempt,
            outcome: "unknown" as const,
            finishedAt: this.finishedAt(tx, prepared.attempt),
            retryable: true,
            completedAfterAcknowledgement: page.acknowledgedBy !== null,
          };
      const recorded = await tx.attempts.finish(finished);
      const step = await tx.steps.get(prepared.delivery.stepId);
      const steps = escalationSteps(page.policy, page.createdAt);
      const index = steps.findIndex(
        (entry) => entry.id === step?.logicalStepId,
      );
      const next = steps[index + 1]?.dueAt;
      const pageClosed =
        page.state === "acknowledged" || page.state === "resolved";
      const closed =
        pageClosed ||
        (next !== undefined && Date.parse(next) <= Date.parse(tx.now));
      if (closed && prepared.delivery.channel === "pushover") {
        const id = pagingWorkId(
          tx.workspaceId,
          "cancel-after",
          prepared.delivery.id,
          prepared.attempt.id,
        );
        await tx.work.enqueue("job", {
          id,
          kind: "paging.cancel",
          idempotencyKey: id,
          payload: {
            pageId: page.id,
            deliveryId: prepared.delivery.id,
            attemptId: prepared.attempt.id,
            secretId: prepared.secretId,
            approvedSecretIds: [prepared.secretId],
          },
          dueAt: tx.now,
        });
      }
      if (
        finished.outcome === "accepted" &&
        !pageClosed &&
        prepared.delivery.channel === "pushover" &&
        finished.providerReceiptId
      ) {
        const id = pagingWorkId(
          tx.workspaceId,
          "receipt",
          prepared.delivery.id,
          finished.id,
        );
        await tx.work.enqueue("job", {
          id,
          kind: "paging.receipt",
          idempotencyKey: id,
          payload: {
            pageId: page.id,
            deliveryId: prepared.delivery.id,
            attemptId: finished.id,
            receiptId: finished.providerReceiptId,
            secretId: prepared.secretId,
            approvedSecretIds: [prepared.secretId],
            pollUntil: new Date(
              Date.parse(prepared.attempt.startedAt) + this.ackTtlMs,
            ).toISOString(),
          },
          dueAt: new Date(Date.parse(tx.now) + 5000).toISOString(),
        });
      }
      if (!recorded) {
        // Recovery has already classified the old attempt as unknown. Keep that
        // immutable result and append the late evidence without touching its retry.
        await tx.audit.append({
          id: pagingWorkId(tx.workspaceId, "late-result", prepared.attempt.id),
          workspaceId: tx.workspaceId,
          actor: { kind: "system", component: "paging" },
          action: "delivery.late_result",
          subjectType: "delivery",
          subjectId: prepared.delivery.id,
          recordedAt: this.finishedAt(tx, prepared.attempt),
          metadata: {
            attemptId: prepared.attempt.id,
            outcome: finished.outcome,
            receiptId: finished.providerReceiptId,
            afterAcknowledgement: page.acknowledgedBy !== null,
          },
        });
        return { state: "stale" };
      }
      if (finished.outcome === "accepted") {
        return {
          state: "completed",
          outcome: "accepted",
          ...(finished.providerReceiptId
            ? { receipt: finished.providerReceiptId }
            : {}),
        };
      }
      if (closed || !finished.retryable)
        return {
          state: "failed",
          outcome: finished.outcome === "unknown" ? "unknown" : "rejected",
        };
      return {
        state: "retry",
        delayMs: retryDelay(prepared.attempt.attempt, {
          retryBaseMs: 5000,
          retryMaxMs: 60000,
          random: this.random,
        }),
        outcome: finished.outcome === "unknown" ? "unknown" : "rejected",
      };
    });
  }
}
