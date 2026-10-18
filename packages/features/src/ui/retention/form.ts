import {
  replayCoverageQuerySchema,
  utcTimestampSchema,
  updateReplayRetentionSchema,
  type ReplayCoverageQuery,
  type ReplayRetentionPolicy,
} from "../../contracts/index.js";
export function policyInput(
  days: string,
  mib: string,
  configured: ReplayRetentionPolicy | null,
) {
  if (!days.trim() || !mib.trim())
    throw new Error("Missing retention settings");
  return updateReplayRetentionSchema.parse({
    days: Number(days),
    maxBytes: Math.round(Number(mib) * 1024 ** 2),
    expectedVersion: configured?.version ?? null,
  });
}
export function coverageInput(
  kind: ReplayCoverageQuery["kind"],
  id: string,
  start: string,
  end: string,
  cutoff: string,
): ReplayCoverageQuery {
  const instant = (value: string) => {
    const time = Date.parse(value);
    if (!Number.isFinite(time)) throw new Error("Invalid date");
    const date = new Date(time);
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
      // Reject normalized calendar dates and nonexistent local DST times.
      if (localDateInput(date) !== value) throw new Error("Invalid local date");
    } else {
      utcTimestampSchema.parse(value);
    }
    return date.toISOString();
  };
  return replayCoverageQuerySchema.parse({
    kind,
    id,
    startAt: instant(start),
    endAt: instant(end),
    visibleAt: instant(cutoff),
  });
}
export function localDateInput(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
