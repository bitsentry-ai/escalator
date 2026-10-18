import {
  hasCapability,
  type Actor,
  type WorkspaceId,
} from "../../contracts/index.js";
import {
  replayCoverageQuerySchema,
  replayCoverageSnapshotSchema,
  type ReplayCoverageQuery,
  type ReplayCoverageSnapshot,
  type ReplayCoverageResult,
} from "../../contracts/replay-reader.js";
import type { PeriodicCoverageInput } from "../../contracts/replay-coverage.js";
import { PersistenceError } from "../ports/persistence.js";
import { eventCoverage, periodicCoverage } from "./coverage.js";
export interface ReplayCoverageRepository {
  /** One database snapshot: authorize scope, verify stream exists and project bounded metadata.
   * Include configuration predecessor(s), all changes and receipts in the requested half-open
   * window. On any query bound return complete=false, not a successful prefix.
   */
  snapshot(
    scope: WorkspaceId,
    query: ReplayCoverageQuery,
  ): Promise<ReplayCoverageSnapshot>;
}
export function replayCoverageSegments(
  configurations: ReplayCoverageSnapshot["configurations"],
  query: Pick<ReplayCoverageQuery, "startAt" | "endAt">,
): PeriodicCoverageInput["segments"] {
  const segments: PeriodicCoverageInput["segments"] = [];
  let priorVersion = 0,
    priorEffective = -Infinity,
    knownSeen = false,
    historyCoherent = true;
  for (let i = 0; i < configurations.length; i++) {
    const config = configurations[i]!;
    if (config.version <= priorVersion)
      throw new RangeError("Unordered configuration revisions");
    priorVersion = config.version;
    if (config.effectiveAt === null) {
      // Legacy metric revisions before migration have no original availability.
      if (knownSeen) historyCoherent = false;
      continue;
    }
    const effective = Date.parse(config.effectiveAt);
    if (effective < priorEffective) historyCoherent = false;
    priorEffective = effective;
    knownSeen = true;
    const next = configurations[i + 1]?.effectiveAt ?? query.endAt;
    const from = Math.max(Date.parse(query.startAt), effective);
    const to = Math.min(Date.parse(query.endAt), Date.parse(next));
    if (to <= from) continue;
    segments.push({
      startAt: new Date(from).toISOString(),
      endAt: new Date(to).toISOString(),
      version: config.version,
      recordedAt: config.recordedAt,
      enabled: config.enabled,
      anchorAt: config.anchorAt,
      stepSeconds: config.stepSeconds,
    });
  }
  return historyCoherent ? segments : [];
}
export class ReplayCoverageReader {
  constructor(private readonly repository: ReplayCoverageRepository) {}
  async read(
    actor: Actor,
    raw: ReplayCoverageQuery,
  ): Promise<ReplayCoverageResult> {
    if (!hasCapability(actor.role, "service:read"))
      throw new Error("forbidden");
    const query = replayCoverageQuerySchema.parse(raw);
    const data = replayCoverageSnapshotSchema.parse(
      await this.repository.snapshot(actor.workspaceId, query),
    );
    if (
      data.workspaceId !== actor.workspaceId ||
      data.streamId !== query.id ||
      data.kind !== query.kind
    )
      throw new PersistenceError("scope_violation");
    if (Date.parse(query.visibleAt) > Date.parse(data.snapshotAt))
      throw new RangeError("Future evidence cutoff");
    const common = {
      workspaceId: actor.workspaceId,
      streamId: query.id,
      startAt: query.startAt,
      endAt: query.endAt,
      visibleAt: query.visibleAt,
      complete: data.complete,
    };
    if (query.kind === "signal")
      return {
        query,
        snapshotAt: data.snapshotAt,
        unassignedReceipts: 0,
        report: eventCoverage({
          ...common,
          events: data.receipts.map(({ id, observedAt, receivedAt }) => ({
            id,
            observedAt,
            receivedAt,
          })),
        }),
      };
    const segments = replayCoverageSegments(data.configurations, query);
    let unassignedReceipts = 0;
    const samples: PeriodicCoverageInput["samples"] = [];
    const configurations = new Map(
      data.configurations.map((row) => [row.version, row]),
    );
    const ids = new Set<string>();
    for (const receipt of data.receipts) {
      if (ids.has(receipt.id))
        throw new RangeError("Duplicate receipt identity");
      ids.add(receipt.id);
      const slot = Date.parse(receipt.slotAt ?? receipt.observedAt);
      if (slot < Date.parse(query.startAt) || slot >= Date.parse(query.endAt))
        throw new RangeError("Receipt outside requested window");
      if (receipt.slotAt === null || receipt.version === null) {
        unassignedReceipts++;
        continue;
      }
      const config = configurations.get(receipt.version);
      const observed = Date.parse(receipt.observedAt);
      // A delayed probe cannot establish health at the earlier scheduled bucket.
      const withinBucket =
        query.kind !== "probe" ||
        (config !== undefined &&
          observed >= slot &&
          observed < slot + config.stepSeconds * 1000);
      samples.push({
        id: receipt.id,
        version: receipt.version,
        slotAt: receipt.slotAt,
        observedAt: receipt.observedAt,
        receivedAt: receipt.receivedAt,
        usable: receipt.usable && withinBucket,
      });
    }
    return {
      query,
      snapshotAt: data.snapshotAt,
      unassignedReceipts,
      report: periodicCoverage({
        ...common,
        segments,
        samples,
      }),
    };
  }
}
