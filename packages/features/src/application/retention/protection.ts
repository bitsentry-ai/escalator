import {
  utcTimestampSchema,
  type WorkspaceId,
  type MetricMonitor,
} from "../../contracts/index.js";
import { metricPointAt, metricWindowAt } from "../metrics/schedule.js";
import {
  hasTerminalReceiptWork,
  type PruneReceiptIdentity,
  type PruneWorkRecord,
} from "./terminal-work.js";
/** Hosts establish reference/processed facts under source locks; the decision is shared. */
export function replayReceiptProtection(
  scope: WorkspaceId,
  monitor: MetricMonitor | null,
  databaseNow: string,
) {
  utcTimestampSchema.parse(databaseNow);
  if (monitor && monitor.workspaceId !== scope)
    throw new Error("Retention monitor scope differs");
  const liveStart = monitor?.enabled
    ? metricWindowAt(
        monitor,
        metricPointAt(
          new Date(
            Date.parse(databaseNow) - 2 * monitor.stepSeconds * 1000,
          ).toISOString(),
          monitor.stepSeconds,
        ),
      ).startAt
    : null;
  return (
    receipt: PruneReceiptIdentity & {
      observedAt: string;
      referenced: boolean;
      processed: boolean;
    },
    work: PruneWorkRecord | undefined,
  ): boolean => {
    utcTimestampSchema.parse(receipt.observedAt);
    return (
      receipt.referenced ||
      !receipt.processed ||
      !hasTerminalReceiptWork(scope, receipt, work) ||
      (receipt.kind === "metric" &&
        monitor !== null &&
        receipt.ownerId === monitor.id &&
        receipt.version === monitor.version &&
        liveStart !== null &&
        Date.parse(receipt.observedAt) >= Date.parse(liveStart))
    );
  };
}
