import {
  ruleBacktestRecordSchema,
  type RuleBacktestRecord,
} from "../../contracts/backtest-record.js";
import {
  detectionRuleVersionSchema,
  type DetectionRuleVersion,
} from "../../contracts/rule-state.js";
import { compareUtcTimestamps } from "../../contracts/timestamps.js";
/** Eligibility is about whether a review has usable evidence, not a prediction
 * that a rule is accurate. Unlabeled reports retain null precision. No invented
 * precision threshold converts an AI suggestion into an approved rule. */
export function ruleActivationEligibility(
  rawVersion: DetectionRuleVersion,
  rawReport: RuleBacktestRecord | null,
): {
  eligible: boolean;
  reason:
    | "usable_history"
    | "report_required"
    | "different_version"
    | "not_backtestable"
    | "insufficient_history";
} {
  const version = detectionRuleVersionSchema.parse(rawVersion);
  if (!rawReport) return { eligible: false, reason: "report_required" };
  const record = ruleBacktestRecordSchema.parse(rawReport),
    report = record.report;
  if (
    record.workspaceId !== version.definition.workspaceId ||
    JSON.stringify(report.rule) !== JSON.stringify(version)
  )
    return { eligible: false, reason: "different_version" };
  if (report.status !== "BACKTESTED")
    return { eligible: false, reason: "not_backtestable" };
  const requiredMs =
    Math.max(
      version.definition.persistenceSeconds,
      version.definition.recoverySeconds,
    ) * 1000;
  // A late isolated window cannot validate a duration-based rule. Availability
  // ranges contain consecutive usable decisions; gaps reset this requirement.
  const usable = report.availability.available.some(
    (range) =>
      compareUtcTimestamps(
        range.lastDecisionAt,
        report.simulation.warmupUntil,
      ) >= 0 &&
      Date.parse(range.lastDecisionAt) - Date.parse(range.firstDecisionAt) >=
        requiredMs,
  );
  return usable
    ? { eligible: true, reason: "usable_history" }
    : { eligible: false, reason: "insufficient_history" };
}
