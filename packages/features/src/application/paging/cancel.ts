import type {
  OperationalPage,
  RecipientDelivery,
} from "../../contracts/index.js";
import { escalationSteps } from "../../domain/escalation/ladder.js";
import type { PagingTransaction } from "./persistence.js";
import { pagingWorkId } from "./work-ids.js";

/** Caller holds the page lock. Provider requests never run in this transaction. */
export async function cancelDeliveryWork(
  tx: PagingTransaction,
  deliveries: readonly RecipientDelivery[],
  cancelReceipts = true,
): Promise<void> {
  if (
    deliveries.length > 100 ||
    deliveries.some((entry) => entry.workspaceId !== tx.workspaceId)
  )
    throw new Error("Invalid cancellation batch");
  await tx.work.cancel(
    "outbox",
    deliveries.map((entry) => pagingWorkId(tx.workspaceId, "send", entry.id)),
  );
  if (cancelReceipts) {
    await tx.work.cancel(
      "job",
      deliveries.map((entry) =>
        pagingWorkId(tx.workspaceId, "receipt", entry.id),
      ),
    );
  }
  for (const delivery of deliveries) {
    if (cancelReceipts) {
      // Every accepted attempt has its own receipt, including a late response
      // from an attempt recovery had already marked unknown.
      let after: string | undefined;
      do {
        const batch = await tx.attempts.forDelivery(delivery.id, {
          limit: 100,
          after,
        });
        await tx.work.cancel(
          "job",
          batch.items.map((attempt) =>
            pagingWorkId(tx.workspaceId, "receipt", delivery.id, attempt.id),
          ),
        );
        after = batch.next ?? undefined;
      } while (after);
    }
    if (delivery.channel !== "pushover") continue;
    const id = pagingWorkId(tx.workspaceId, "cancel", delivery.id);
    await tx.work.enqueue("job", {
      id,
      kind: "paging.cancel",
      idempotencyKey: id,
      payload: {
        pageId: delivery.pageId,
        deliveryId: delivery.id,
        secretId: delivery.secretId,
        approvedSecretIds: delivery.secretId ? [delivery.secretId] : [],
      },
      dueAt: tx.now,
    });
  }
}
export async function cancelPageWork(
  tx: PagingTransaction,
  page: OperationalPage,
): Promise<void> {
  await tx.work.cancel(
    "job",
    escalationSteps(page.policy, page.createdAt).map((step) =>
      pagingWorkId(tx.workspaceId, "step", page.id, step.id),
    ),
  );
  let after: string | undefined;
  do {
    const batch = await tx.deliveries.forPage(page.id, { limit: 100, after });
    await cancelDeliveryWork(tx, batch.items);
    after = batch.next ?? undefined;
  } while (after);
}
