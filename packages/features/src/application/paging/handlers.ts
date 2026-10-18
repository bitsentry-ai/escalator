import type { ReceiptChannel } from "../../adapters/channels/ports.js";
import type { WorkHandlers } from "../jobs/scheduler.js";
import type { WorkHandler } from "../jobs/runner.js";
import type { DispatchRepository } from "./routing.js";
import { PageAdvancement } from "./advance.js";
import { PageDelivery, type PagingChannelFactory } from "./send.js";
import { PagingProviderJobs } from "./provider-jobs.js";
export const pagingJobLanes = [
  ["paging.step"],
  ["paging.receipt"],
  ["paging.cancel"],
] as const;
/** Hosts supply adapters; orchestration and registered kinds remain shared. */
export function createPagingHandlers(
  repository: DispatchRepository,
  channels: { forDelivery: PagingChannelFactory; receipts: ReceiptChannel },
  publicUrl: string,
): WorkHandlers {
  const advance = new PageAdvancement(repository);
  const delivery = new PageDelivery(
    repository,
    channels.forDelivery,
    publicUrl,
  );
  const provider = new PagingProviderJobs(repository, channels.receipts);
  return {
    job: new Map<string, WorkHandler>([
      ["paging.step", (lease) => advance.advance(lease)],
      ["paging.receipt", (lease, signal) => provider.poll(lease, signal)],
      ["paging.cancel", (lease, signal) => provider.cancel(lease, signal)],
    ]),
    outbox: new Map<string, WorkHandler>([
      ["paging.send", (lease, signal) => delivery.send(lease, signal)],
    ]),
  };
}
