import {
  detectionRuleSchema,
  type DetectionRule,
  type RuleWindow,
} from "../../contracts/rules.js";
import {
  ruleHistorySnapshotSchema,
  ruleMeasurementHashSchema,
  type RuleHistorySnapshot,
} from "../../contracts/rule-history.js";
import { utcTimestampSchema } from "../../contracts/entities.js";
import { ruleWindowBounds, ruleSampleTime } from "../../domain/rules/time.js";
import { PersistenceError } from "../ports/persistence.js";
import { selectPeriodicCoverage } from "../retention/coverage.js";
import { replayCoverageSegments } from "../retention/reader.js";
import { expectDefined } from "../../contracts/expect-defined.js";

type HistoryData = ReturnType<typeof ruleHistorySnapshotSchema.parse>;
function assertHistoryScope(data: HistoryData, rule: DetectionRule): void {
  if (
    data.workspaceId !== rule.workspaceId ||
    data.serviceId !== rule.serviceId ||
    data.environmentId !== rule.environmentId ||
    data.kind !== rule.selector.kind ||
    data.streamId !== rule.selector.streamId ||
    data.receipts.some(
      ({ sample }) =>
        sample.workspaceId !== rule.workspaceId ||
        sample.serviceId !== rule.serviceId ||
        sample.environmentId !== rule.environmentId ||
        sample.kind !== rule.selector.kind ||
        sample.streamId !== rule.selector.streamId,
    )
  )
    throw new PersistenceError("scope_violation");
}
/**
 * Projects the receipts in (start, end] onto their configuration slots; undefined when a receipt lacks the slot or
 * configuration needed to certify coverage.
 */
function collectHistorySamples(
  data: HistoryData,
  rule: DetectionRule,
  configurations: Map<number, HistoryData["configurations"][number]>,
  { start, end }: { start: number; end: number },
) {
  const ids = new Set<string>();
  const samples = [];
  const selectedReceipts = new Map<
    string,
    RuleHistorySnapshot["receipts"][number]
  >();
  for (const row of data.receipts) {
    const sample = row.sample;
    if (ids.has(sample.id)) throw new RangeError("Duplicate receipt identity");
    ids.add(sample.id);
    const bin = ruleSampleTime(rule, sample);
    if (bin <= start || bin > end) continue;
    if (sample.kind === "signal") throw new PersistenceError("scope_violation");
    if (sample.slotAt == null || row.version === null) return undefined;
    const config = configurations.get(row.version);
    if (!config) return undefined;
    const slot = Date.parse(sample.slotAt),
      observed = Date.parse(sample.observedAt);
    const chronological =
      observed >= slot &&
      (sample.receivedAt === null || observed <= Date.parse(sample.receivedAt));
    const withinBucket =
      sample.kind !== "probe" || observed < slot + config.stepSeconds * 1000;
    samples.push({
      id: sample.id,
      version: row.version,
      slotAt: sample.slotAt,
      observedAt: sample.observedAt,
      receivedAt: sample.receivedAt,
      usable: sample.usable && chronological && withinBucket,
    });
    selectedReceipts.set(sample.id, row);
  }
  return { samples, selectedReceipts };
}
/** Hosts must bind the expected measurement hash to the reviewed rule revision.
 * A current configuration cannot retroactively certify an old measurement.
 * The same projection is used for a live decision and each simulated decision.
 */
export function ruleWindowFromHistory(
  rawRule: DetectionRule,
  rawDecisionAt: string,
  raw: RuleHistorySnapshot,
  expectedMeasurementHash: string,
): RuleWindow {
  const rule = detectionRuleSchema.parse(rawRule);
  const decisionAt = utcTimestampSchema.parse(rawDecisionAt);
  const data = ruleHistorySnapshotSchema.parse(raw);
  const expected = ruleMeasurementHashSchema.parse(expectedMeasurementHash);
  assertHistoryScope(data, rule);
  const { start, end, visibleAt } = ruleWindowBounds(rule, decisionAt);
  if (
    data.visibleAt !== decisionAt ||
    Date.parse(data.startAt) !== start ||
    Date.parse(data.endAt) !== end
  )
    throw new RangeError("History range/cutoff mismatch");
  if (visibleAt > Date.parse(data.snapshotAt))
    throw new RangeError("Future evidence cutoff");
  const window: RuleWindow = {
    decisionAt,
    complete: data.complete,
    coverage: "unknown",
    samples: [],
  };
  if (!data.complete) return window;
  // Event counts alone cannot establish source continuity or a clean recovery.
  // Signal configuration/health history is required before certifying coverage.
  if (rule.selector.kind === "signal") {
    window.samples = data.receipts.map((row) => row.sample);
    return window;
  }
  const configurations = new Map(
    data.configurations.map((row) => [row.version, row]),
  );
  if (configurations.size !== data.configurations.length)
    throw new RangeError("Duplicate configuration revision");
  const segments = replayCoverageSegments(data.configurations, {
    startAt: new Date(start).toISOString(),
    endAt: new Date(end + 1).toISOString(),
  });
  // A different cadence cannot prove one measurement per rule bin. Unknown or
  // incompatible history is reported rather than resampled or invented.
  if (
    segments.some(
      (segment) =>
        segment.stepSeconds !== rule.stepSeconds ||
        configurations.get(segment.version)?.measurementHash !== expected,
    )
  )
    return window;
  const collected = collectHistorySamples(data, rule, configurations, {
    start,
    end,
  });
  if (!collected) return window;
  const { samples, selectedReceipts } = collected;
  const selection = selectPeriodicCoverage(
    {
      workspaceId: rule.workspaceId,
      streamId: rule.selector.streamId,
      startAt: new Date(start).toISOString(),
      endAt: new Date(end).toISOString(),
      visibleAt: decisionAt,
      complete: data.complete,
      segments,
      samples,
    },
    { endInclusive: true },
  );
  const { gaps, expectedSlots, availableSlots } = selection.report;
  if (gaps.length) window.coverage = "gaps";
  else if (
    expectedSlots === rule.windowSeconds / rule.stepSeconds &&
    availableSlots === expectedSlots
  )
    window.coverage = "complete";
  else window.coverage = "unknown";
  window.samples = selection.samples.map(
    (row) =>
      expectDefined(selectedReceipts.get(row.id), "selected receipt").sample,
  );
  return window;
}
