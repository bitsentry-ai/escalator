import { utcTimestampSchema, type WorkspaceId } from "../../contracts/index.js";
import { signalProcessingPayloadSchema } from "../detection/process.js";
import { probeJobPayloadSchema } from "../probes/execute.js";
import { probeJobId } from "../probes/schedule.js";
import { metricJobPayloadSchema } from "../metrics/jobs.js";
import { metricJobId } from "../metrics/schedule.js";
export type PruneReceiptIdentity =
  | { kind: "signal"; id: string }
  | { kind: "probe" | "metric"; id: string; ownerId: string; version: number };
export interface PruneWorkRecord {
  id: string;
  kind: string;
  state: string;
  payload: unknown;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  completedAt: string | null;
}
/** Missing, malformed, live, retryable and failed work never authorizes payload deletion.
 * Reference/window protection is checked separately under the source lock.
 */
export function hasTerminalReceiptWork(
  scope: WorkspaceId,
  receipt: PruneReceiptIdentity,
  work: PruneWorkRecord | undefined,
): boolean {
  if (
    !work ||
    work.state !== "completed" ||
    work.leaseToken !== null ||
    work.leaseExpiresAt !== null ||
    !utcTimestampSchema.safeParse(work.completedAt).success
  )
    return false;
  if (receipt.kind === "signal") {
    const payload = signalProcessingPayloadSchema.safeParse(work.payload);
    return (
      work.kind === "signal.process" &&
      work.id === `signal.process:${receipt.id}` &&
      payload.success &&
      payload.data.signalId === receipt.id
    );
  }
  if (receipt.kind === "probe") {
    const payload = probeJobPayloadSchema.safeParse(work.payload);
    return (
      work.kind === "probe.execute" &&
      work.id === receipt.id &&
      payload.success &&
      payload.data.probeId === receipt.ownerId &&
      payload.data.probeVersion === receipt.version &&
      probeJobId(
        scope,
        receipt.ownerId,
        receipt.version,
        payload.data.dueAt,
      ) === work.id
    );
  }
  if (receipt.kind !== "metric") return false;
  const payload = metricJobPayloadSchema.safeParse(work.payload);
  return (
    work.kind === "metrics.poll" &&
    work.id === receipt.id &&
    payload.success &&
    payload.data.monitorId === receipt.ownerId &&
    payload.data.monitorVersion === receipt.version &&
    metricJobId(scope, receipt.ownerId, receipt.version, payload.data.dueAt) ===
      work.id
  );
}
