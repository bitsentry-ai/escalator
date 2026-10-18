import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CoverageReport } from "../src/ui/retention/CoverageReport.js";
import { coverageInput, policyInput } from "../src/ui/retention/form.js";
import {
  replayRetentionPolicySchema,
  type ReplayCoverageResult,
} from "../src/contracts/index.js";
import { escalatorResources } from "../src/locales/index.js";
const query = {
  kind: "probe" as const,
  id: "probe",
  startAt: "2026-10-01T00:00:00.000Z",
  endAt: "2026-10-02T00:00:00.000Z",
  visibleAt: "2026-10-02T00:00:00.000Z",
};
test("retention forms preserve the edit version and convert MiB without accepting empty or unsafe input", () => {
  const configured = replayRetentionPolicySchema.parse({
    workspaceId: "team",
    version: 7,
    days: 30,
    maxBytes: 1024 ** 3,
    updatedAt: query.endAt,
  });
  assert.deepEqual(policyInput("14", "1.5", configured), {
    days: 14,
    maxBytes: 1572864,
    expectedVersion: 7,
  });
  for (const [days, mib] of [
    ["", "1"],
    ["1", ""],
    ["1.5", "1"],
    ["1", "Infinity"],
    ["1", "0"],
  ])
    assert.throws(() => policyInput(days!, mib!, null));
  assert.equal(policyInput("30", "5120", null).expectedVersion, null);
});
test("coverage forms enforce a bounded past window and explicit evidence cutoff", () => {
  assert.deepEqual(
    coverageInput(
      "probe",
      "probe",
      query.startAt,
      query.endAt,
      query.visibleAt,
    ),
    query,
  );
  for (const [start, end, cutoff] of [
    ["bad", query.endAt, query.visibleAt],
    ["2026-02-30T10:00", query.endAt, query.visibleAt],
    [query.endAt, query.startAt, query.visibleAt],
    ["2026-08-01T00:00:00Z", query.endAt, query.visibleAt],
    [query.startAt, query.endAt, query.startAt],
  ])
    assert.throws(() => coverageInput("probe", "probe", start!, end!, cutoff!));
});
test("coverage rendering bounds gap rows and never treats unknown sampling as healthy", () => {
  const result: ReplayCoverageResult = {
    query,
    snapshotAt: query.endAt,
    unassignedReceipts: 2,
    report: {
      coverageVersion: 1,
      queryComplete: false,
      expectedSlots: 0,
      availableSlots: 0,
      gaps: Array.from({ length: 101 }, (_, i) => ({
        startAt: `gap-${i}`,
        endAt: query.endAt,
        reason: "configuration_unknown" as const,
      })),
    },
  };
  const html = renderToStaticMarkup(
    createElement(CoverageReport, { result, t: (key) => key }),
  );
  assert.match(html, /retention.truncated/);
  assert.match(html, /retention.noExpectation/);
  assert.match(html, /retention.gap.configuration_unknown/);
  assert.match(html, /gap-99</);
  assert.doesNotMatch(html, /gap-100</);
});
test("event evidence does not claim continuous monitoring", () => {
  const result: ReplayCoverageResult = {
    query: { ...query, kind: "signal" },
    snapshotAt: query.endAt,
    unassignedReceipts: 0,
    report: {
      coverageVersion: 1,
      queryComplete: true,
      visibleCount: 3,
      lateCount: 1,
      retrospectiveCount: 2,
      continuity: "not_inferred",
    },
  };
  const html = renderToStaticMarkup(
    createElement(CoverageReport, { result, t: (key) => key }),
  );
  assert.match(html, /retention.noContinuity/);
  assert.match(html, /retention.retrospective/);
  assert.doesNotMatch(html, /retention.available/);
});
test("all coverage gap reasons have nonempty labels in all six locales", () => {
  for (const locale of Object.values(escalatorResources)) {
    const { retention } = {
      ...escalatorResources["en-US"].escalator,
      ...locale.escalator,
    };
    for (const reason of [
      "configuration_unknown",
      "configuration_unavailable",
      "disabled",
      "missing",
      "late",
      "retrospective",
      "unusable",
      "query_truncated",
    ] as const)
      assert.ok(retention.gap[reason].trim());
  }
});
