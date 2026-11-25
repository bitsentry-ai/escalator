import { Temporal } from "@js-temporal/polyfill";
import {
  scheduleSchema,
  utcTimestampSchema,
  workingHoursSchema,
  type Rotation,
  type Schedule,
  type WorkingHours,
  type ScheduleAssignment,
  type SchedulePreviewInterval,
} from "../../contracts/index.js";
import { expectDefined } from "../../contracts/expect-defined.js";
import { compareCodeUnits } from "../../contracts/ordering.js";
export class ScheduleError extends Error {
  constructor(
    readonly code:
      | "invalid_schedule"
      | "conflicting_override"
      | "preview_limit",
  ) {
    super(code);
  }
}
const instant = (value: string) =>
  Temporal.Instant.from(utcTimestampSchema.parse(value));
const iso = (value: Temporal.Instant) =>
  value.toString({ smallestUnit: "millisecond" });
function anchor(rotation: Rotation) {
  return Temporal.PlainDateTime.from(rotation.anchorLocal, {
    overflow: "reject",
  });
}
function boundary(rotation: Rotation, index: number): Temporal.Instant {
  return anchor(rotation)
    .add({ days: index * rotation.shiftDays })
    .toZonedDateTime(rotation.timeZone, {
      disambiguation: rotation.disambiguation,
    })
    .toInstant();
}
/** Rotation ids and each rotation's responders are unique, and every rotation starts before its end. */
function assertRotations(rotations: readonly Rotation[]): void {
  const ids = new Set<string>();
  for (const rotation of rotations) {
    if (
      ids.has(rotation.id) ||
      new Set(rotation.responders).size !== rotation.responders.length
    )
      throw new ScheduleError("invalid_schedule");
    ids.add(rotation.id);
    try {
      const start = boundary(rotation, 0);
      if (
        rotation.until &&
        Temporal.Instant.compare(start, instant(rotation.until)) >= 0
      )
        throw new ScheduleError("invalid_schedule");
    } catch {
      throw new ScheduleError("invalid_schedule");
    }
  }
}
/** Override ids are unique, and approved overrides for different responders never overlap. */
function assertOverrides(overrides: Schedule["overrides"]): void {
  const ids = new Set<string>();
  for (const override of overrides) {
    if (ids.has(override.id)) throw new ScheduleError("invalid_schedule");
    ids.add(override.id);
  }
  const approved = overrides.filter((entry) => entry.approved);
  for (let i = 0; i < approved.length; i++) {
    const a = approved[i];
    for (const b of approved.slice(i + 1))
      if (
        a.responderId !== b.responderId &&
        Date.parse(a.startsAt) < Date.parse(b.endsAt) &&
        Date.parse(b.startsAt) < Date.parse(a.endsAt)
      )
        throw new ScheduleError("conflicting_override");
  }
}
/** Validation is also used before publishing an immutable schedule revision. */
export function validateSchedule(value: unknown): Schedule {
  const schedule = scheduleSchema.parse(value);
  assertRotations(schedule.rotations);
  assertOverrides(schedule.overrides);
  return schedule;
}
function rotationAt(
  rotation: Rotation,
  at: Temporal.Instant,
): ScheduleAssignment | null {
  if (
    rotation.until &&
    Temporal.Instant.compare(at, instant(rotation.until)) >= 0
  )
    return null;
  const local = at.toZonedDateTimeISO(rotation.timeZone);
  const days = anchor(rotation)
    .toPlainDate()
    .until(local.toPlainDate(), { largestUnit: "day" }).days;
  let index = Math.floor(days / rotation.shiftDays);
  let start = boundary(rotation, index);
  if (Temporal.Instant.compare(start, at) > 0) {
    index--;
    start = boundary(rotation, index);
  }
  let end = boundary(rotation, index + 1);
  // A date-line transition can skip a whole local date. Ignore zero-length shifts.
  for (let count = 0; Temporal.Instant.compare(end, at) <= 0; count++) {
    if (count > 2) throw new ScheduleError("invalid_schedule");
    index++;
    start = end;
    end = boundary(rotation, index + 1);
  }
  if (index < 0) return null;
  if (
    rotation.until &&
    Temporal.Instant.compare(end, instant(rotation.until)) > 0
  )
    end = instant(rotation.until);
  return {
    responderId: rotation.responders[index % rotation.responders.length],
    source: "rotation",
    sourceId: rotation.id,
    startsAt: iso(start),
    endsAt: iso(end),
  };
}
function resolveValidated(
  schedule: Schedule,
  at: Temporal.Instant,
): ScheduleAssignment | null {
  if (!schedule.enabled) return null;
  const timestamp = at.epochMilliseconds;
  const override = schedule.overrides
    .filter(
      (entry) =>
        entry.approved &&
        Date.parse(entry.startsAt) <= timestamp &&
        timestamp < Date.parse(entry.endsAt),
    )
    .sort((a, b) => compareCodeUnits(a.id, b.id))[0];
  if (override)
    return {
      responderId: override.responderId,
      source: "override",
      sourceId: override.id,
      startsAt: iso(instant(override.startsAt)),
      endsAt: iso(instant(override.endsAt)),
    };
  const rotations = [...schedule.rotations].sort(
    (a, b) => b.priority - a.priority || compareCodeUnits(a.id, b.id),
  );
  for (const rotation of rotations) {
    const assignment = rotationAt(rotation, at);
    if (assignment) return assignment;
  }
  return null;
}
/** Duty selection never checks working hours: an assigned primary still gets paged overnight. */
export function resolveSchedule(
  value: unknown,
  at: string,
): ScheduleAssignment | null {
  return resolveValidated(validateSchedule(value), instant(at));
}
/** The rotation's shifts from about two before `start` until `end`, cut at its end date; at most 40. */
function rotationShifts(
  rotation: Rotation,
  start: Temporal.Instant,
  end: Temporal.Instant,
): ScheduleAssignment[] {
  const shifts: ScheduleAssignment[] = [];
  const until = rotation.until ? instant(rotation.until) : undefined;
  const days = anchor(rotation)
    .toPlainDate()
    .until(start.toZonedDateTimeISO(rotation.timeZone).toPlainDate(), {
      largestUnit: "day",
    }).days;
  let index = Math.max(0, Math.floor(days / rotation.shiftDays) - 2);
  for (let count = 0; count < 40; count++, index++) {
    const left = boundary(rotation, index);
    if (
      Temporal.Instant.compare(left, end) >= 0 ||
      (until && Temporal.Instant.compare(left, until) >= 0)
    )
      break;
    let right = boundary(rotation, index + 1);
    if (until && Temporal.Instant.compare(right, until) > 0) right = until;
    shifts.push({
      responderId: rotation.responders[index % rotation.responders.length],
      source: "rotation",
      sourceId: rotation.id,
      startsAt: iso(left),
      endsAt: iso(right),
    });
  }
  return shifts;
}
/** A bounded exact-boundary sweep; gaps are explicit, never inferred from sampling. */
export function previewSchedule(
  value: unknown,
  from: string,
  to: string,
): SchedulePreviewInterval[] {
  const schedule = validateSchedule(value);
  const start = instant(from),
    end = instant(to);
  const range = end.epochMilliseconds - start.epochMilliseconds;
  if (range <= 0 || range > 31 * 86_400_000)
    throw new ScheduleError("preview_limit");
  if (!schedule.enabled)
    return [{ startsAt: iso(start), endsAt: iso(end), assignment: null }];
  type Candidate = { assignment: ScheduleAssignment; priority: number };
  const candidates: Candidate[] = [];
  const events = new Map<number, { start: number[]; end: number[] }>();
  const event = (at: number) => {
    let value = events.get(at);
    if (!value) {
      value = { start: [], end: [] };
      events.set(at, value);
    }
    return value;
  };
  event(start.epochMilliseconds);
  event(end.epochMilliseconds);
  const add = (assignment: ScheduleAssignment, priority: number) => {
    const from = Math.max(
      Date.parse(assignment.startsAt),
      start.epochMilliseconds,
    );
    const to = Math.min(Date.parse(assignment.endsAt), end.epochMilliseconds);
    if (from >= to) return;
    const id = candidates.length;
    candidates.push({ assignment, priority });
    event(from).start.push(id);
    event(to).end.push(id);
  };
  for (const override of schedule.overrides)
    if (override.approved)
      add(
        {
          responderId: override.responderId,
          source: "override",
          sourceId: override.id,
          startsAt: iso(instant(override.startsAt)),
          endsAt: iso(instant(override.endsAt)),
        },
        101,
      );
  for (const rotation of schedule.rotations)
    for (const shift of rotationShifts(rotation, start, end))
      add(shift, rotation.priority);
  const sorted = [...events.keys()].sort((a, b) => a - b);
  if (sorted.length > 2000) throw new ScheduleError("preview_limit");
  const active = new Map<number, Candidate>();
  return sorted.slice(0, -1).map((point, index) => {
    const changes = expectDefined(events.get(point), "schedule change");
    for (const id of changes.end) active.delete(id);
    for (const id of changes.start) active.set(id, candidates[id]);
    const chosen = [...active.values()].sort(
      (a, b) =>
        b.priority - a.priority ||
        compareCodeUnits(a.assignment.sourceId, b.assignment.sourceId),
    )[0];
    return {
      startsAt: iso(Temporal.Instant.fromEpochMilliseconds(point)),
      endsAt: iso(Temporal.Instant.fromEpochMilliseconds(sorted[index + 1])),
      assignment: chosen?.assignment ?? null,
    };
  });
}
/** Declared working hours are availability, not evidence that somebody is awake. */
export function isWorkingAt(value: WorkingHours, at: string): boolean {
  const hours = workingHoursSchema.parse(value);
  const local = instant(at).toZonedDateTimeISO(hours.timeZone);
  const minute = local.hour * 60 + local.minute;
  // ISO weekdays run Monday 1 to Sunday 7.
  const previousDay = local.dayOfWeek === 1 ? 7 : local.dayOfWeek - 1;
  return hours.windows.some((window) => {
    if (window.startMinute < window.endMinute)
      return (
        window.weekdays.includes(local.dayOfWeek) &&
        minute >= window.startMinute &&
        minute < window.endMinute
      );
    // An overnight window starts on a listed day and ends on the next day.
    return (
      (window.weekdays.includes(local.dayOfWeek) &&
        minute >= window.startMinute) ||
      (window.weekdays.includes(previousDay) && minute < window.endMinute)
    );
  });
}
