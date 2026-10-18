import assert from "node:assert/strict";
import test from "node:test";
import { periodicCoverage } from "../src/application/retention/coverage.js";
import { periodicCoverageInputSchema } from "../src/contracts/replay-coverage.js";
const at = (minute: number) =>
  new Date(Date.UTC(2026, 9, 3, 0, minute)).toISOString();
const sample = (minute: number, overrides = {}) => ({
  id: `sample-${minute}`,
  version: 1,
  slotAt: at(minute),
  observedAt: at(minute),
  receivedAt: at(minute),
  usable: true,
  ...overrides,
});
const input = (overrides = {}) =>
  periodicCoverageInputSchema.parse({
    workspaceId: "workspace",
    streamId: "probe",
    startAt: at(0),
    endAt: at(4),
    visibleAt: at(5),
    complete: true,
    segments: [
      {
        startAt: at(0),
        endAt: at(4),
        version: 1,
        recordedAt: at(0),
        enabled: true,
        anchorAt: at(0),
        stepSeconds: 60,
      },
    ],
    samples: [sample(0), sample(1), sample(2), sample(3)],
    ...overrides,
  });
test("coverage detects an interior hole despite matching first and last samples", () => {
  const report = periodicCoverage(input({ samples: [sample(0), sample(3)] }));
  assert.equal(report.expectedSlots, 4);
  assert.equal(report.availableSlots, 2);
  assert.deepEqual(report.gaps, [
    { startAt: at(1), endAt: at(3), reason: "missing" },
  ]);
});
test("unknown receipt time and late evidence never become available samples", () => {
  const report = periodicCoverage(
    input({
      samples: [
        sample(0),
        sample(1, { receivedAt: null }),
        sample(2, { receivedAt: at(6) }),
        sample(3, { usable: false }),
      ],
    }),
  );
  assert.equal(report.availableSlots, 1);
  assert.deepEqual(
    report.gaps.map((gap) => gap.reason),
    ["retrospective", "late", "unusable"],
  );
});
test("a newer visible correction supersedes the older receipt but future corrections do not", () => {
  const base = [sample(0), sample(1), sample(2), sample(3)];
  assert.equal(
    periodicCoverage(
      input({
        samples: [
          ...base,
          sample(1, { id: "correction", receivedAt: at(4), usable: false }),
        ],
      }),
    ).availableSlots,
    3,
  );
  assert.equal(
    periodicCoverage(
      input({
        samples: [
          ...base,
          sample(1, { id: "future", receivedAt: at(6), usable: false }),
        ],
      }),
    ).availableSlots,
    4,
  );
});
test("truncated reads cannot claim complete coverage from the returned prefix", () => {
  const report = periodicCoverage(input({ complete: false }));
  assert.equal(report.queryComplete, false);
  assert.equal(report.availableSlots, 0);
  assert.deepEqual(report.gaps, [
    { startAt: at(0), endAt: at(4), reason: "query_truncated" },
  ]);
});
test("missing historical configuration and explicitly disabled intervals remain visible", () => {
  const segment = input().segments[0]!;
  const report = periodicCoverage(
    input({
      segments: [
        { ...segment, startAt: at(1), endAt: at(2), recordedAt: null },
        { ...segment, startAt: at(2), enabled: false },
      ],
    }),
  );
  assert.equal(report.expectedSlots, 0);
  assert.deepEqual(
    report.gaps.map((gap) => gap.reason),
    ["configuration_unknown", "configuration_unavailable", "disabled"],
  );
});
test("configuration revisions and changed cadence cannot borrow each other's receipts", () => {
  const segment = input().segments[0]!;
  const report = periodicCoverage(
    input({
      segments: [
        { ...segment, endAt: at(2) },
        { ...segment, startAt: at(2), version: 2, stepSeconds: 120 },
      ],
    }),
  );
  assert.equal(report.expectedSlots, 3);
  assert.equal(report.availableSlots, 2);
  assert.deepEqual(report.gaps, [
    { startAt: at(2), endAt: at(4), reason: "missing" },
  ]);
});
test("half-open windows exclude the right boundary", () => {
  const report = periodicCoverage(
    input({ samples: [...input().samples, sample(4)] }),
  );
  assert.equal(report.expectedSlots, 4);
  assert.equal(report.availableSlots, 4);
  assert.deepEqual(report.gaps, []);
});
test("overlapping manifests, duplicate identities and excessive slot counts fail closed", () => {
  const segment = input().segments[0]!;
  assert.throws(
    () => periodicCoverage(input({ segments: [segment, segment] })),
    /overlapping/,
  );
  assert.throws(
    () => periodicCoverage(input({ samples: [sample(0), sample(0)] })),
    /Duplicate/,
  );
  assert.throws(
    () =>
      periodicCoverage(
        input({
          endAt: at(2000),
          visibleAt: at(2000),
          segments: [{ ...segment, endAt: at(2000), stepSeconds: 1 }],
        }),
      ),
    /slot limit/,
  );
});

test("event-driven silence never implies continuous or healthy monitoring", async () => {
  const { eventCoverage } =
    await import("../src/application/retention/coverage.js");
  const report = eventCoverage({
    workspaceId: input().workspaceId,
    streamId: "source",
    startAt: at(0),
    endAt: at(4),
    visibleAt: at(5),
    complete: true,
    events: [],
  });
  assert.deepEqual(report, {
    coverageVersion: 1,
    visibleCount: 0,
    lateCount: 0,
    retrospectiveCount: 0,
    queryComplete: true,
    continuity: "not_inferred",
  });
});

test("the repeated European autumn hour does not collapse UTC evidence slots", () => {
  const utc = (minute: number) =>
    new Date(Date.UTC(2026, 9, 25, 0, minute)).toISOString();
  const report = periodicCoverage(
    input({
      startAt: utc(0),
      endAt: utc(180),
      visibleAt: utc(180),
      segments: [
        {
          ...input().segments[0]!,
          startAt: utc(0),
          endAt: utc(180),
          anchorAt: utc(0),
          recordedAt: utc(0),
        },
      ],
      samples: Array.from({ length: 180 }, (_, minute) =>
        sample(minute, {
          slotAt: utc(minute),
          observedAt: utc(minute),
          receivedAt: utc(minute),
        }),
      ),
    }),
  );
  assert.equal(report.expectedSlots, 180);
  assert.equal(report.availableSlots, 180);
  assert.deepEqual(report.gaps, []);
});
