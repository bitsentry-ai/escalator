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
import type { WorkspaceId } from "../../contracts/identity.js";
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
function validSendClaim(
  workspaceId: WorkspaceId,
  claimed: { queue: string; kind: string; id: string },
  payload: z.infer<typeof payloadSchema>,
  pageId: string,
): boolean {
  return (
    payload.pageId === pageId &&
    claimed.queue === "outbox" &&
    claimed.kind === "paging.send" &&
    claimed.id === pagingWorkId(workspaceId, "send", payload.deliveryId) &&
    payload.approvedSecretIds[0] === payload.secretId
  );
}
async function deliveryAttempts(
  tx: PagingTransaction,
  deliveryId: string,
): Promise<DeliveryAttempt[]> {
  const attempts: DeliveryAttempt[] = [];
  let after: string | undefined;
  do {
    const batch = await tx.attempts.forDelivery(deliveryId, {
      limit: 100,
      after,
    });
    attempts.push(...batch.items);
    after = batch.next ?? undefined;
  } while (after);
  return attempts;
}
/**
 * The result when earlier attempts already decide this delivery: an accepted send completes it, this claim's own
 * attempt makes the job stale, and a permanent failure rejects it.
 */
function settledByAttempts(
  attempts: readonly DeliveryAttempt[],
  claimToken: string,
): WorkHandlerResult | undefined {
  const accepted = attempts.find((entry) => entry.outcome === "accepted");
  if (accepted)
    return {
      state: "completed",
      outcome: "accepted",
      ...(accepted.providerReceiptId
        ? { receipt: accepted.providerReceiptId }
        : {}),
    };
  if (attempts.some((entry) => entry.claimToken === claimToken))
    return { state: "stale" };
  if (attempts.some((entry) => entry.outcome === "failed" && !entry.retryable))
    return { state: "failed", outcome: "rejected" };
  return undefined;
}
/** A delivery is closed once its page is acknowledged or resolved, or its next escalation step is due. */
async function deliveryClosed(
  tx: PagingTransaction,
  page: {
    state: string;
    policy: Parameters<typeof escalationSteps>[0];
    createdAt: string;
  },
  stepId: string,
): Promise<{ pageClosed: boolean; closed: boolean }> {
  const step = await tx.steps.get(stepId);
  const steps = escalationSteps(page.policy, page.createdAt);
  const index = steps.findIndex((entry) => entry.id === step?.logicalStepId);
  const next = steps[index + 1]?.dueAt;
  const pageClosed = page.state === "acknowledged" || page.state === "resolved";
  return {
    pageClosed,
    closed:
      pageClosed ||
      (next !== undefined && Date.parse(next) <= Date.parse(tx.now)),
  };
}
/** Cancels the provider's emergency retries for a delivery that no longer needs them. */
async function enqueueProviderCancel(
  tx: PagingTransaction,
  pageId: string,
  prepared: Prepared,
): Promise<void> {
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
      pageId,
      deliveryId: prepared.delivery.id,
      attemptId: prepared.attempt.id,
      secretId: prepared.secretId,
      approvedSecretIds: [prepared.secretId],
    },
    dueAt: tx.now,
  });
}
/** Polls the provider receipt of an accepted delivery for an acknowledgement until it expires. */
async function enqueueReceiptPoll(
  tx: PagingTransaction,
  pageId: string,
  prepared: Prepared,
  receipt: { attemptId: string; receiptId: string; pollUntil: string },
): Promise<void> {
  const id = pagingWorkId(
    tx.workspaceId,
    "receipt",
    prepared.delivery.id,
    receipt.attemptId,
  );
  await tx.work.enqueue("job", {
    id,
    kind: "paging.receipt",
    idempotencyKey: id,
    payload: {
      pageId,
      deliveryId: prepared.delivery.id,
      attemptId: receipt.attemptId,
      receiptId: receipt.receiptId,
      secretId: prepared.secretId,
      approvedSecretIds: [prepared.secretId],
      pollUntil: receipt.pollUntil,
    },
    dueAt: new Date(Date.parse(tx.now) + 5000).toISOString(),
  });
}
/** The attempt as the channel finished it; a result that fails validation is recorded as unknown and retryable. */
function finishedAttempt(
  attempt: DeliveryAttempt,
  result: ChannelSendResult,
  finishedAt: string,
  afterAcknowledgement: boolean,
): DeliveryAttempt {
  const candidate = deliveryAttemptSchema.safeParse({
    ...attempt,
    outcome: attemptOutcome(result.outcome),
    finishedAt,
    providerReceiptId: result.outcome === "accepted" ? result.receiptId : null,
    completedAfterAcknowledgement: afterAcknowledgement,
    retryable: result.outcome !== "accepted" && result.retryable,
    failureReason: result.outcome === "rejected" ? result.reason : null,
  });
  if (candidate.success) return candidate.data;
  return {
    ...attempt,
    outcome: "unknown",
    finishedAt,
    retryable: true,
    completedAfterAcknowledgement: afterAcknowledgement,
  };
}
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
      if (!page || !validSendClaim(tx.workspaceId, claimed, payload, page.id))
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
      const attempts = await deliveryAttempts(tx, delivery.id);
      const settled = settledByAttempts(attempts, claimed.token);
      if (settled) return settled;
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
  /** Accepted completes; a closed step or a permanent failure fails; anything else retries with backoff. */
  private outcome(
    finished: DeliveryAttempt,
    closed: boolean,
    attempt: number,
  ): WorkHandlerResult {
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
      delayMs: retryDelay(attempt, {
        retryBaseMs: 5000,
        retryMaxMs: 60000,
        random: this.random,
      }),
      outcome: finished.outcome === "unknown" ? "unknown" : "rejected",
    };
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
      const finished = finishedAttempt(
        prepared.attempt,
        result,
        this.finishedAt(tx, prepared.attempt),
        page.acknowledgedBy !== null,
      );
      const recorded = await tx.attempts.finish(finished);
      const { pageClosed, closed } = await deliveryClosed(
        tx,
        page,
        prepared.delivery.stepId,
      );
      const pushover = prepared.delivery.channel === "pushover";
      if (pushover && closed)
        await enqueueProviderCancel(tx, page.id, prepared);
      if (
        pushover &&
        finished.outcome === "accepted" &&
        !pageClosed &&
        finished.providerReceiptId
      )
        await enqueueReceiptPoll(tx, page.id, prepared, {
          attemptId: finished.id,
          receiptId: finished.providerReceiptId,
          pollUntil: new Date(
            Date.parse(prepared.attempt.startedAt) + this.ackTtlMs,
          ).toISOString(),
        });
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
      return this.outcome(finished, closed, prepared.attempt.attempt);
    });
  }
}
