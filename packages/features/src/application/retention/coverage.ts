import { compareUtcTimestamps } from "../../contracts/timestamps.js";
import {
  periodicCoverageInputSchema,
  eventCoverageInputSchema,
  type PeriodicCoverageInput,
  type EventCoverageInput,
  type CoverageSample,
  type CoverageReason,
  type CoverageGap,
  type PeriodicCoverageReport,
  type EventCoverageReport,
} from "../../contracts/replay-coverage.js";
import { compareCodeUnits } from "../../contracts/ordering.js";
/** Why a slot has no usable receipt: one arrived unusable, without a receipt time, too late, or never. */
function gapReason(
  anyKnown: boolean,
  receipts: readonly { receivedAt: string | null }[],
): CoverageReason {
  if (anyKnown) return "unusable";
  if (receipts.some((row) => row.receivedAt === null)) return "retrospective";
  if (receipts.length > 0) return "late";
  return "missing";
}
const iso = (at: number) => new Date(at).toISOString();
/** Half-open UTC windows. Coverage describes retained evidence, never service health.
 * visibleAt is a snapshot cutoff, not a substitute for per-decision replay filtering.
 * Hosts derive segments from immutable configuration history, not today's schedule.
 */
export interface PeriodicCoverageSelection {
  report: PeriodicCoverageReport;
  samples: {
    id: string;
    version: number;
    slotAt: string;
    stepSeconds: number;
  }[];
}
export function periodicCoverage(
  raw: PeriodicCoverageInput,
): PeriodicCoverageReport {
  return computePeriodicCoverage(raw, false).report;
}
/** The health evaluator must use these exact receipts, never a separately selected
 * earlier usable value when the newest available receipt says the slot is unusable.
 */
export function selectPeriodicCoverage(
  raw: PeriodicCoverageInput,
  options: { endInclusive?: boolean } = {},
): PeriodicCoverageSelection {
  return computePeriodicCoverage(raw, true, options.endInclusive ?? false);
}
function assertCoverageWindow(start: number, end: number, visible: number) {
  if (end <= start || end - start > 366 * 86400000 || end > visible)
    throw new RangeError("Invalid coverage window");
}
/** Receipts grouped by configuration version and slot; a receipt id may appear only once. */
function receiptsBySlot(
  samples: readonly CoverageSample[],
): Map<string, CoverageSample[]> {
  const bySlot = new Map<string, CoverageSample[]>();
  const ids = new Set<string>();
  for (const sample of samples) {
    if (ids.has(sample.id)) throw new RangeError("Duplicate receipt identity");
    ids.add(sample.id);
    const key = `${sample.version}:${Date.parse(sample.slotAt)}`;
    const receipts = bySlot.get(key) ?? [];
    receipts.push(sample);
    bySlot.set(key, receipts);
  }
  return bySlot;
}
/** Receipts received and observed by the cutoff, newest receipt first. */
function visibleReceipts(
  receipts: readonly CoverageSample[],
  visibleAt: string,
) {
  return receipts
    .filter(
      (row): row is CoverageSample & { receivedAt: string } =>
        row.receivedAt !== null &&
        compareUtcTimestamps(row.receivedAt, visibleAt) <= 0 &&
        compareUtcTimestamps(row.observedAt, visibleAt) <= 0,
    )
    .sort(
      (a, b) =>
        compareUtcTimestamps(b.receivedAt, a.receivedAt) ||
        compareCodeUnits(b.id, a.id),
    );
}
/** A segment recorded after the cutoff, or disabled, covers none of its slots. */
function segmentGap(
  segment: { recordedAt: string | null; enabled: boolean },
  visibleAt: string,
): CoverageReason | undefined {
  if (
    segment.recordedAt === null ||
    compareUtcTimestamps(segment.recordedAt, visibleAt) > 0
  )
    return "configuration_unavailable";
  if (!segment.enabled) return "disabled";
  return undefined;
}
/** Adds a gap, merging it into the previous one when it continues it for the same reason. */
function addGap(
  gaps: CoverageGap[],
  from: number,
  to: number,
  reason: CoverageReason,
): void {
  if (to <= from) return;
  const previous = gaps.at(-1);
  if (previous?.reason === reason && previous.endAt === iso(from))
    previous.endAt = iso(to);
  else gaps.push({ startAt: iso(from), endAt: iso(to), reason });
}
interface SlotScan {
  bySlot: Map<string, CoverageSample[]>;
  visibleAt: string;
  tally: { expectedSlots: number; availableSlots: number };
  selected: PeriodicCoverageSelection["samples"] | undefined;
  gap: (from: number, to: number, reason: CoverageReason) => void;
}
/** Counts each scheduled slot of a segment within [from, to) as available or as a gap. */
function scanSlots(
  segment: { version: number; stepSeconds: number; anchorAt: string },
  from: number,
  to: number,
  scan: SlotScan,
): void {
  const step = segment.stepSeconds * 1000,
    anchor = Date.parse(segment.anchorAt);
  const first = anchor + Math.ceil((from - anchor) / step) * step;
  for (let slot = first; slot < to; slot += step) {
    if (++scan.tally.expectedSlots > 100000)
      throw new RangeError("Coverage slot limit exceeded");
    const receipts = scan.bySlot.get(`${segment.version}:${slot}`) ?? [];
    const known = visibleReceipts(receipts, scan.visibleAt);
    if (known[0]?.usable) {
      scan.tally.availableSlots++;
      scan.selected?.push({
        id: known[0].id,
        version: segment.version,
        slotAt: iso(slot),
        stepSeconds: segment.stepSeconds,
      });
      continue;
    }
    scan.gap(
      slot,
      Math.min(to, slot + step),
      gapReason(known.length > 0, receipts),
    );
  }
}
function computePeriodicCoverage(
  raw: PeriodicCoverageInput,
  collect: boolean,
  endInclusive = false,
): PeriodicCoverageSelection {
  const selected: PeriodicCoverageSelection["samples"] = [];
  const input = periodicCoverageInputSchema.parse(raw);
  const rawStart = Date.parse(input.startAt),
    rawEnd = Date.parse(input.endAt);
  const visible = Date.parse(input.visibleAt);
  assertCoverageWindow(rawStart, rawEnd, visible);
  // Coverage arithmetic uses milliseconds. Only iteration boundaries change
  // for (start,end]; the availability cutoff and all evidence stay untouched.
  // Callers requesting this mode must supply configuration segments through
  // the inclusive endpoint. Returned gaps use the equivalent half-open range.
  const start = rawStart + (endInclusive ? 1 : 0),
    end = rawEnd + (endInclusive ? 1 : 0);
  const gaps: CoverageGap[] = [];
  const gap = (from: number, to: number, reason: CoverageReason) =>
    addGap(gaps, from, to, reason);
  if (!input.complete) {
    gap(start, end, "query_truncated");
    return {
      report: {
        coverageVersion: 1,
        expectedSlots: 0,
        availableSlots: 0,
        gaps,
        queryComplete: false,
      },
      samples: selected,
    };
  }
  const samples = receiptsBySlot(input.samples);
  let cursor = start,
    previousEnd = -Infinity;
  const scan: SlotScan = {
    bySlot: samples,
    visibleAt: input.visibleAt,
    tally: { expectedSlots: 0, availableSlots: 0 },
    selected: collect ? selected : undefined,
    gap,
  };
  for (const segment of input.segments) {
    const rawStart = Date.parse(segment.startAt),
      rawEnd = Date.parse(segment.endAt);
    if (rawEnd <= rawStart || rawStart < previousEnd)
      throw new RangeError("Unordered or overlapping configuration history");
    previousEnd = rawEnd;
    const from = Math.max(start, rawStart),
      to = Math.min(end, rawEnd);
    if (to <= from) continue;
    gap(cursor, from, "configuration_unknown");
    cursor = to;
    const unavailable = segmentGap(segment, input.visibleAt);
    if (unavailable) {
      gap(from, to, unavailable);
      continue;
    }
    scanSlots(segment, from, to, scan);
  }
  gap(cursor, end, "configuration_unknown");
  return {
    report: {
      coverageVersion: 1,
      ...scan.tally,
      gaps,
      queryComplete: true,
    },
    samples: selected,
  };
}

/** An event-driven source has no promised cadence. Silence is not a clean negative. */
export function eventCoverage(raw: EventCoverageInput): EventCoverageReport {
  const input = eventCoverageInputSchema.parse(raw);
  const start = Date.parse(input.startAt),
    end = Date.parse(input.endAt),
    visible = Date.parse(input.visibleAt);
  if (end <= start || end - start > 366 * 86400000 || end > visible)
    throw new RangeError("Invalid coverage window");
  let visibleCount = 0,
    lateCount = 0,
    retrospectiveCount = 0;
  const ids = new Set<string>();
  for (const event of input.events) {
    if (ids.has(event.id)) throw new RangeError("Duplicate event identity");
    ids.add(event.id);
    if (
      compareUtcTimestamps(event.observedAt, input.startAt) < 0 ||
      compareUtcTimestamps(event.observedAt, input.endAt) >= 0
    )
      throw new RangeError("Event outside requested window");
    if (event.receivedAt === null) retrospectiveCount++;
    else if (compareUtcTimestamps(event.receivedAt, input.visibleAt) > 0)
      lateCount++;
    else visibleCount++;
  }
  return {
    coverageVersion: 1,
    visibleCount,
    lateCount,
    retrospectiveCount,
    queryComplete: input.complete,
    continuity: "not_inferred" as const,
  };
}
