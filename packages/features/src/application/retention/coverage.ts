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
): PeriodicCoverageSelection {
  return computePeriodicCoverage(raw, true);
}
function computePeriodicCoverage(
  raw: PeriodicCoverageInput,
  collect: boolean,
): PeriodicCoverageSelection {
  const selected: PeriodicCoverageSelection["samples"] = [];
  const input = periodicCoverageInputSchema.parse(raw);
  const start = Date.parse(input.startAt),
    end = Date.parse(input.endAt);
  const visible = Date.parse(input.visibleAt);
  if (end <= start || end - start > 366 * 86400000 || end > visible)
    throw new RangeError("Invalid coverage window");
  const gaps: CoverageGap[] = [];
  const gap = (from: number, to: number, reason: CoverageReason) => {
    if (to <= from) return;
    const previous = gaps.at(-1);
    if (previous?.reason === reason && previous.endAt === iso(from))
      previous.endAt = iso(to);
    else gaps.push({ startAt: iso(from), endAt: iso(to), reason });
  };
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
  const samples = new Map<string, CoverageSample[]>();
  const ids = new Set<string>();
  for (const sample of input.samples) {
    if (ids.has(sample.id)) throw new RangeError("Duplicate receipt identity");
    ids.add(sample.id);
    const key = `${sample.version}:${Date.parse(sample.slotAt)}`;
    const receipts = samples.get(key) ?? [];
    receipts.push(sample);
    samples.set(key, receipts);
  }
  let cursor = start,
    previousEnd = -Infinity,
    expectedSlots = 0,
    availableSlots = 0;
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
    if (
      segment.recordedAt === null ||
      Date.parse(segment.recordedAt) > visible
    ) {
      gap(from, to, "configuration_unavailable");
      continue;
    }
    if (!segment.enabled) {
      gap(from, to, "disabled");
      continue;
    }
    const step = segment.stepSeconds * 1000,
      anchor = Date.parse(segment.anchorAt);
    const first = anchor + Math.ceil((from - anchor) / step) * step;
    for (let slot = first; slot < to; slot += step) {
      if (++expectedSlots > 100000)
        throw new RangeError("Coverage slot limit exceeded");
      const receipts = samples.get(`${segment.version}:${slot}`) ?? [];
      const known = receipts
        .filter(
          (row) =>
            row.receivedAt !== null &&
            Date.parse(row.receivedAt) <= visible &&
            Date.parse(row.observedAt) <= visible,
        )
        .sort(
          (a, b) =>
            Date.parse(b.receivedAt!) - Date.parse(a.receivedAt!) ||
            (b.id > a.id ? 1 : b.id < a.id ? -1 : 0),
        );
      if (known[0]?.usable) {
        availableSlots++;
        if (collect)
          selected.push({
            id: known[0].id,
            version: segment.version,
            slotAt: iso(slot),
            stepSeconds: segment.stepSeconds,
          });
        continue;
      }
      const reason: CoverageReason = known.length
        ? "unusable"
        : receipts.some((row) => row.receivedAt === null)
          ? "retrospective"
          : receipts.length
            ? "late"
            : "missing";
      gap(slot, Math.min(to, slot + step), reason);
    }
  }
  gap(cursor, end, "configuration_unknown");
  return {
    report: {
      coverageVersion: 1,
      expectedSlots,
      availableSlots,
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
    const observed = Date.parse(event.observedAt);
    if (observed < start || observed >= end)
      throw new RangeError("Event outside requested window");
    if (event.receivedAt === null) retrospectiveCount++;
    else if (Date.parse(event.receivedAt) > visible) lateCount++;
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
