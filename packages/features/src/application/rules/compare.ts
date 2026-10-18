import {
  ruleBaselineCaptureSchema,
  ruleComparisonSchema,
  type RuleComparison,
} from "../../contracts/rule-comparison.js";
import type { RuleReplaySnapshot } from "../../contracts/rule-replay.js";
import type { RuleBacktestReport } from "../../contracts/rule-backtest.js";
import {
  compareUtcTimestamps,
  hasSubmillisecondTime,
} from "../../contracts/timestamps.js";
import { PersistenceError } from "../ports/persistence.js";
/** Actual recorded rule openings, not a counterfactual replay of current rules.
 * Missing recording time/mode and uncovered decisions remain explicit. */
export function compareRecordedRules(
  snapshot: RuleReplaySnapshot,
  report: Pick<RuleBacktestReport, "episodes" | "coverage">,
): RuleComparison {
  const raw = snapshot.retained?.baselines;
  if (!raw)
    return {
      basis: "recorded_rule_decisions",
      status: "no_recorded_comparison",
      captureComplete: false,
      legacyUnknown: true,
      candidatePredictedOpenings: report.episodes.length,
      candidateEvaluatedDecisions: report.coverage.evaluatedDecisions,
      groups: [],
    };
  const capture = ruleBaselineCaptureSchema.parse(raw),
    definition = snapshot.version.definition;
  if (
    compareUtcTimestamps(capture.visibleAt, snapshot.snapshotAt) !== 0 ||
    compareUtcTimestamps(capture.firstDecisionAt, snapshot.firstDecisionAt) !==
      0 ||
    compareUtcTimestamps(capture.lastDecisionAt, snapshot.lastDecisionAt) !== 0
  )
    throw new Error("Baseline capture range mismatch");
  const keys = new Set<string>();
  const groups = capture.groups.map((observation) => {
    const version = observation.version,
      d = version.definition;
    if (
      d.workspaceId !== definition.workspaceId ||
      d.serviceId !== definition.serviceId ||
      d.environmentId !== definition.environmentId ||
      d.selector.kind !== definition.selector.kind ||
      d.selector.streamId !== definition.selector.streamId
    )
      throw new PersistenceError("scope_violation");
    const key = JSON.stringify([
      version.id,
      version.revision,
      observation.generation,
      observation.mode,
    ]);
    if (keys.has(key)) throw new Error("Duplicate baseline group");
    keys.add(key);
    const step = d.stepSeconds * 1000,
      first = Math.ceil(Date.parse(capture.firstDecisionAt) / step) * step,
      last = Math.floor(Date.parse(capture.lastDecisionAt) / step) * step;
    const expectedDecisions = Math.max(0, (last - first) / step + 1);
    if (
      observation.decisions > expectedDecisions ||
      [
        observation.firstObservedDecisionAt,
        observation.lastObservedDecisionAt,
      ].some(
        (at) => hasSubmillisecondTime(at) || Date.parse(at) % step !== 0,
      ) ||
      compareUtcTimestamps(
        observation.firstObservedDecisionAt,
        capture.firstDecisionAt,
      ) < 0 ||
      compareUtcTimestamps(
        observation.lastObservedDecisionAt,
        capture.lastDecisionAt,
      ) > 0 ||
      compareUtcTimestamps(
        observation.firstObservedDecisionAt,
        observation.lastObservedDecisionAt,
      ) > 0
    )
      throw new Error("Observed baseline exceeds requested range");
    return {
      observation,
      expectedDecisions,
      coverage: expectedDecisions
        ? observation.evaluated / expectedDecisions
        : 0,
      missingDecisions: expectedDecisions - observation.decisions,
    };
  });
  return ruleComparisonSchema.parse({
    basis: "recorded_rule_decisions",
    captureComplete: capture.complete,
    legacyUnknown: capture.legacyUnknown,
    status: !groups.length
      ? "no_recorded_comparison"
      : capture.complete &&
          !capture.legacyUnknown &&
          groups.every(
            (g) => g.missingDecisions === 0 && g.observation.unknown === 0,
          )
        ? "available"
        : "partial",
    candidatePredictedOpenings: report.episodes.length,
    candidateEvaluatedDecisions: report.coverage.evaluatedDecisions,
    groups,
  });
}
