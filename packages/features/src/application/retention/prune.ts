import { z } from "zod";
import {
  opaqueIdSchema,
  workspaceIdSchema,
  utcTimestampSchema,
  type ReplayRetentionSettings,
} from "../../contracts/index.js";
import {
  retentionTarget,
  replayUsageSchema,
  type ReplayUsage,
} from "./policy.js";
const candidateSchema = z.strictObject({
  workspaceId: workspaceIdSchema,
  sourceId: opaqueIdSchema,
  kind: z.enum(["signal", "probe", "metric"]),
  id: opaqueIdSchema,
  observedAt: utcTimestampSchema,
  bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  /** Established under the source lock by the host's reference and live-work checks. */
  protected: z.boolean(),
});
const batchSchema = z.strictObject({
  workspaceId: workspaceIdSchema,
  sourceId: opaqueIdSchema,
  limit: z.number().int().min(1).max(100),
  candidates: z.array(candidateSchema).max(1000),
});
export type ReplayPruneBatch = z.infer<typeof batchSchema>;
/** Plan a bounded batch for ONE locked source. The caller must apply it atomically
 * with tombstones, dependent terminal receipts and accounting, before releasing locks.
 * Returned byte pressure is a prediction, never evidence that a deletion committed.
 */
export function planReplayPrune(
  settings: ReplayRetentionSettings,
  databaseNow: string,
  usage: ReplayUsage,
  raw: ReplayPruneBatch,
) {
  const input = batchSchema.parse(raw);
  const snapshot = replayUsageSchema.parse(usage);
  const target = retentionTarget(settings, databaseNow, snapshot);
  const identities = new Set<string>();
  let candidateBytes = 0,
    protectedBytes = 0;
  for (const candidate of input.candidates) {
    if (
      candidate.workspaceId !== input.workspaceId ||
      candidate.sourceId !== input.sourceId
    )
      throw new RangeError("Prune candidate scope mismatch");
    const key = `${candidate.kind}:${candidate.id}`;
    if (identities.has(key)) throw new RangeError("Duplicate prune candidate");
    identities.add(key);
    candidateBytes += candidate.bytes;
    if (candidate.protected) protectedBytes += candidate.bytes;
    if (
      !Number.isSafeInteger(candidateBytes) ||
      candidateBytes > snapshot.retainedBytes ||
      protectedBytes > snapshot.protectedBytes ||
      candidateBytes - protectedBytes >
        snapshot.retainedBytes - snapshot.protectedBytes
    )
      throw new RangeError("Candidates exceed the usage snapshot");
  }
  const candidates = [...input.candidates].sort((a, b) => {
    const left = `${a.kind}:${a.id}`,
      right = `${b.kind}:${b.id}`;
    return (
      Date.parse(a.observedAt) - Date.parse(b.observedAt) ||
      (left < right ? -1 : left > right ? 1 : 0)
    );
  });
  const selected: { kind: "signal" | "probe" | "metric"; id: string }[] = [];
  let plannedBytes = 0,
    pressure = target.overBudgetBytes;
  for (const candidate of candidates) {
    if (selected.length === input.limit) break;
    if (
      candidate.protected ||
      (Date.parse(candidate.observedAt) >= Date.parse(target.cutoffAt) &&
        pressure === 0)
    )
      continue;
    selected.push({ kind: candidate.kind, id: candidate.id });
    plannedBytes += candidate.bytes;
    pressure = Math.max(0, pressure - candidate.bytes);
  }
  return {
    selected,
    plannedBytes,
    budgetPressureAfterBatch: pressure,
    cutoffAt: target.cutoffAt,
  };
}
