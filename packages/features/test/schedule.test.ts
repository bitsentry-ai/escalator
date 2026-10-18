import test from "node:test";
import assert from "node:assert/strict";
import {
  scheduleSchema,
  scheduleOverrideSchema,
  workingHoursSchema,
  type Schedule,
} from "../src/contracts/index.js";
import {
  resolveSchedule,
  previewSchedule,
  isWorkingAt,
  validateSchedule,
} from "../src/domain/schedule/resolve.js";
const fixture = (rotation: Record<string, unknown> = {}): Schedule =>
  scheduleSchema.parse({
    id: "oncall",
    workspaceId: "workspace",
    serviceId: "api",
    name: "API on call",
    version: 1,
    enabled: true,
    rotations: [
      {
        id: "main",
        timeZone: "America/New_York",
        anchorLocal: "2024-03-09T09:00",
        shiftDays: 1,
        responders: ["alice", "bob"],
        ...rotation,
      },
    ],
    overrides: [],
  });
test("calendar-day shifts use absolute half-open boundaries across spring forward", () => {
  const schedule = fixture();
  const first = resolveSchedule(schedule, "2024-03-09T14:00:00.000Z")!;
  assert.equal(first.responderId, "alice");
  assert.equal(first.endsAt, "2024-03-10T13:00:00.000Z");
  assert.equal(
    Date.parse(first.endsAt) - Date.parse(first.startsAt),
    23 * 3_600_000,
  );
  assert.equal(
    resolveSchedule(schedule, "2024-03-10T12:59:59.999Z")!.responderId,
    "alice",
  );
  assert.equal(resolveSchedule(schedule, first.endsAt)!.responderId, "bob");
});
test("a fall-back day lasts 25 hours without a duplicate handoff", () => {
  const schedule = fixture({ anchorLocal: "2024-11-02T09:00" });
  const shift = resolveSchedule(schedule, "2024-11-03T05:30:00.000Z")!;
  assert.equal(shift.responderId, "alice");
  assert.deepEqual(
    resolveSchedule(schedule, "2024-11-03T06:30:00.000Z"),
    shift,
  );
  assert.equal(
    Date.parse(shift.endsAt) - Date.parse(shift.startsAt),
    25 * 3_600_000,
  );
  assert.equal(
    resolveSchedule(schedule, "2024-11-03T14:00:00.000Z")!.responderId,
    "bob",
  );
});
test("repeated handoff time is explicit and skipped time follows the declared choice", () => {
  const first = fixture({
    anchorLocal: "2024-11-03T01:30",
    disambiguation: "earlier",
  });
  const second = fixture({
    anchorLocal: "2024-11-03T01:30",
    disambiguation: "later",
  });
  assert.equal(
    resolveSchedule(first, "2024-11-03T05:45:00.000Z")!.startsAt,
    "2024-11-03T05:30:00.000Z",
  );
  assert.equal(resolveSchedule(second, "2024-11-03T05:45:00.000Z"), null);
  assert.equal(
    resolveSchedule(second, "2024-11-03T06:45:00.000Z")!.startsAt,
    "2024-11-03T06:30:00.000Z",
  );
  const gap = fixture({ anchorLocal: "2024-03-10T02:30" });
  assert.equal(resolveSchedule(gap, "2024-03-10T07:00:00.000Z"), null);
  assert.equal(
    resolveSchedule(gap, "2024-03-10T07:30:00.000Z")!.startsAt,
    "2024-03-10T07:30:00.000Z",
  );
});
test("non-hour offset changes also use calendar boundaries", () => {
  const schedule = fixture({
    timeZone: "Australia/Lord_Howe",
    anchorLocal: "2024-04-06T09:00",
  });
  const shift = resolveSchedule(schedule, "2024-04-06T00:00:00.000Z")!;
  assert.equal(
    Date.parse(shift.endsAt) - Date.parse(shift.startsAt),
    24.5 * 3_600_000,
  );
});
test("approved overrides win, drafts do not, and conflicting approval is rejected", () => {
  const schedule = fixture();
  const override = {
    id: "cover",
    responderId: "carol",
    startsAt: "2024-03-09T15:00:00.000Z",
    endsAt: "2024-03-09T17:00:00.000Z",
    approved: false,
  };
  schedule.overrides = [scheduleOverrideSchema.parse(override)];
  assert.equal(
    resolveSchedule(schedule, "2024-03-09T16:00:00.000Z")!.source,
    "rotation",
  );
  schedule.overrides[0]!.approved = true;
  assert.equal(
    resolveSchedule(schedule, "2024-03-09T16:00:00.000Z")!.responderId,
    "carol",
  );
  assert.equal(resolveSchedule(schedule, override.endsAt)!.source, "rotation");
  schedule.overrides.push({
    ...schedule.overrides[0]!,
    id: "conflict",
    responderId: schedule.rotations[0]!.responders[0]!,
  });
  assert.throws(() => validateSchedule(schedule), {
    code: "conflicting_override",
  });
});
test("priority and ID break rotation ties independently of insertion order", () => {
  const schedule = fixture({ id: "z", responders: ["alice"] });
  schedule.rotations.push({
    ...schedule.rotations[0]!,
    id: "a",
    responders: [schedule.rotations[0]!.responders[0]!],
  });
  assert.equal(
    resolveSchedule(schedule, "2024-03-10T15:00:00.000Z")!.sourceId,
    "a",
  );
  schedule.rotations[0]!.priority = 1;
  assert.equal(
    resolveSchedule(schedule, "2024-03-10T15:00:00.000Z")!.sourceId,
    "z",
  );
});
test("preview includes exact gaps, handoffs, override ends and finite rotation ends", () => {
  const schedule = fixture({ until: "2024-03-10T15:00:00.000Z" });
  schedule.overrides.push(
    scheduleOverrideSchema.parse({
      id: "cover",
      responderId: "carol",
      startsAt: "2024-03-09T15:00:00.000Z",
      endsAt: "2024-03-09T17:00:00.000Z",
      approved: true,
    }),
  );
  const preview = previewSchedule(
    schedule,
    "2024-03-09T13:00:00.000Z",
    "2024-03-10T16:00:00.000Z",
  );
  assert.deepEqual(
    preview.map((entry) => entry.assignment?.responderId ?? null),
    [null, "alice", "carol", "alice", "bob", null],
  );
  for (const interval of preview)
    assert.deepEqual(
      interval.assignment,
      resolveSchedule(schedule, interval.startsAt),
    );
  assert.equal(preview.at(-1)!.endsAt, "2024-03-10T16:00:00.000Z");
  assert.throws(
    () =>
      previewSchedule(
        schedule,
        "2024-01-01T00:00:00.000Z",
        "2024-03-01T00:00:00.000Z",
      ),
    { code: "preview_limit" },
  );
});
test("working hours include both repeated wall times and support overnight windows", () => {
  const hours = workingHoursSchema.parse({
    responderId: "alice",
    timeZone: "America/New_York",
    windows: [{ weekdays: [7], startMinute: 60, endMinute: 120 }],
  });
  for (const at of ["2024-11-03T05:30:00.000Z", "2024-11-03T06:30:00.000Z"])
    assert.equal(isWorkingAt(hours, at), true);
  assert.equal(isWorkingAt(hours, "2024-11-03T07:00:00.000Z"), false);
  hours.windows = [{ weekdays: [6], startMinute: 22 * 60, endMinute: 2 * 60 }];
  assert.equal(isWorkingAt(hours, "2024-11-03T06:30:00.000Z"), true);
  assert.equal(isWorkingAt(hours, "2024-11-04T06:30:00.000Z"), false);
  hours.windows = [];
  assert.equal(isWorkingAt(hours, "2024-11-03T06:30:00.000Z"), false);
  assert.ok(
    resolveSchedule(
      fixture({ anchorLocal: "2024-11-02T09:00" }),
      "2024-11-03T06:30:00.000Z",
    ),
  );
});
test("invalid local dates, zones, duplicate identities and empty intervals fail closed", () => {
  assert.throws(
    () => validateSchedule(fixture({ anchorLocal: "2024-02-30T09:00" })),
    { code: "invalid_schedule" },
  );
  assert.throws(() => fixture({ timeZone: "Invalid/Zone" }));
  assert.throws(
    () => validateSchedule(fixture({ responders: ["alice", "alice"] })),
    { code: "invalid_schedule" },
  );
  assert.throws(() =>
    workingHoursSchema.parse({
      responderId: "alice",
      timeZone: "UTC",
      windows: [{ weekdays: [1], startMinute: 60, endMinute: 60 }],
    }),
  );
  const schedule = fixture();
  schedule.enabled = false;
  assert.equal(resolveSchedule(schedule, "2024-03-10T15:00:00.000Z"), null);
  assert.equal(
    previewSchedule(
      schedule,
      "2024-03-10T00:00:00.000Z",
      "2024-03-11T00:00:00.000Z",
    )[0]!.assignment,
    null,
  );
});

test("a skipped whole calendar date creates no zero-length preview assignment", () => {
  const schedule = fixture({
    timeZone: "Pacific/Apia",
    anchorLocal: "2011-12-29T09:00",
    responders: ["alice", "bob", "carol"],
  });
  const preview = previewSchedule(
    schedule,
    "2011-12-29T19:00:00.000Z",
    "2011-12-31T19:00:00.000Z",
  );
  assert.deepEqual(
    preview.map((interval) => interval.assignment?.responderId),
    ["alice", "carol"],
  );
  for (const interval of preview) {
    assert.ok(Date.parse(interval.endsAt) > Date.parse(interval.startsAt));
    assert.deepEqual(
      interval.assignment,
      resolveSchedule(schedule, interval.startsAt),
    );
  }
});
