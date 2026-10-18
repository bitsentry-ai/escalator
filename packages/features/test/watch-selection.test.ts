import test from "node:test";
import assert from "node:assert/strict";
import { workspaceIdSchema } from "../src/contracts/index.js";
import {
  periodicCoverage,
  selectPeriodicCoverage,
} from "../src/application/retention/coverage.js";
import type {
  PeriodicCoverageInput,
  CoverageSample,
} from "../src/contracts/replay-coverage.js";
const at = (seconds: number) =>
  new Date(
    Date.parse("2026-10-04T00:00:00.000Z") + seconds * 1000,
  ).toISOString();
function sample(
  id: string,
  slot: number,
  received: number,
  usable = true,
): CoverageSample {
  return {
    id,
    version: 1,
    slotAt: at(slot),
    observedAt: at(slot),
    receivedAt: at(received),
    usable,
  };
}
function fixture(samples: CoverageSample[]): PeriodicCoverageInput {
  return {
    workspaceId: workspaceIdSchema.parse("watch-test"),
    streamId: "probe",
    startAt: at(0),
    endAt: at(120),
    visibleAt: at(120),
    complete: true,
    segments: [
      {
        startAt: at(0),
        endAt: at(120),
        version: 1,
        recordedAt: at(-60),
        enabled: true,
        anchorAt: at(0),
        stepSeconds: 60,
      },
    ],
    samples,
  };
}
test("selected evidence agrees with coverage and is ordered by scheduled slot", () => {
  const input = fixture([
    sample("later-slot", 60, 65),
    sample("first-slot", 0, 5),
  ]);
  const selection = selectPeriodicCoverage(input);
  assert.deepEqual(selection.report, periodicCoverage(input));
  assert.equal(selection.report.availableSlots, selection.samples.length);
  assert.deepEqual(selection.samples, [
    { id: "first-slot", version: 1, slotAt: at(0), stepSeconds: 60 },
    { id: "later-slot", version: 1, slotAt: at(60), stepSeconds: 60 },
  ]);
});
test("a late correction cannot replace the receipt known at the watch cutoff", () => {
  const input = fixture([
    sample("known", 0, 5),
    sample("late", 0, 121),
    sample("second", 60, 65),
  ]);
  assert.deepEqual(
    selectPeriodicCoverage(input).samples.map((row) => row.id),
    ["known", "second"],
  );
  assert.deepEqual(
    selectPeriodicCoverage({ ...input, visibleAt: at(130) }).samples.map(
      (row) => row.id,
    ),
    ["late", "second"],
  );
});
test("a newer unusable receipt cannot be hidden by an older usable value", () => {
  const input = fixture([
    sample("old-good", 0, 5),
    sample("new-unknown", 0, 10, false),
    sample("second", 60, 65),
  ]);
  const result = selectPeriodicCoverage(input);
  assert.deepEqual(
    result.samples.map((row) => row.id),
    ["second"],
  );
  assert.equal(result.report.availableSlots, 1);
  assert.equal(result.report.gaps[0]!.reason, "unusable");
});
test("receipt tie breaking is deterministic and selects only one value per slot", () => {
  const input = fixture([
    sample("a", 0, 5),
    sample("z", 0, 5),
    sample("second", 60, 65),
  ]);
  assert.deepEqual(
    selectPeriodicCoverage(input).samples.map((row) => row.id),
    ["z", "second"],
  );
  input.samples.reverse();
  assert.deepEqual(
    selectPeriodicCoverage(input).samples.map((row) => row.id),
    ["z", "second"],
  );
});
test("unknown availability and observations beyond the cutoff never enter selected evidence", () => {
  const input = fixture([
    { ...sample("retrospective", 0, 5), receivedAt: null },
    { ...sample("future-observation", 60, 65), observedAt: at(121) },
  ]);
  const result = selectPeriodicCoverage(input);
  assert.deepEqual(result.samples, []);
  assert.equal(result.report.availableSlots, 0);
});
test("unavailable configuration and truncated reads expose no selected values", () => {
  const input = fixture([sample("first", 0, 5), sample("second", 60, 65)]);
  assert.deepEqual(
    selectPeriodicCoverage({ ...input, complete: false }).samples,
    [],
  );
  assert.deepEqual(
    selectPeriodicCoverage({
      ...input,
      segments: input.segments.map((row) => ({ ...row, recordedAt: at(121) })),
    }).samples,
    [],
  );
});
test("wrong revisions and unscheduled sample slots cannot supply health evidence", () => {
  const input = fixture([
    { ...sample("wrong-version", 0, 5), version: 2 },
    sample("wrong-slot", 61, 65),
  ]);
  assert.deepEqual(selectPeriodicCoverage(input).samples, []);
});
test("selected identities do not alias caller-owned receipts and duplicates are rejected", () => {
  const input = fixture([sample("first", 0, 5), sample("second", 60, 65)]);
  const result = selectPeriodicCoverage(input);
  input.samples[0]!.id = "changed";
  assert.equal(result.samples[0]!.id, "first");
  assert.throws(
    () =>
      selectPeriodicCoverage(
        fixture([sample("same", 0, 5), sample("same", 60, 65)]),
      ),
    /Duplicate receipt identity/,
  );
});
