import type { DetectionRuleVersion } from "./rule-state.js";
export interface BacktestEpisode {
  startedAt: string;
  endedAt: string | null;
  outcome: "actionable" | "noise" | "unreviewed";
  labelId: string | null;
}
export interface RuleBacktestReport {
  version: 1;
  evaluatorVersion: 1;
  matchingPolicy: "unique-overlap-v1";
  snapshotId: string;
  rule: DetectionRuleVersion;
  status: "BACKTESTED" | "NOT_BACKTESTABLE";
  reason:
    | "complete"
    | "partial_history"
    | "incomplete_input"
    | "no_usable_history";
  simulation: { initialState: "inactive"; warmupUntil: string };
  range: { firstDecisionAt: string; lastDecisionAt: string };
  coverage: {
    totalDecisions: number;
    evaluatedDecisions: number;
    suppressedDecisions: number;
    unknownDecisions: number;
    fraction: number;
  };
  episodes: BacktestEpisode[];
  reviewedLabels: number;
  unreviewedEpisodes: number;
  ambiguousEpisodes: number;
  truePositives: number;
  falsePositives: number;
  missedLabelIds: string[];
  unevaluableLabelIds: string[];
  precision: {
    value: number | null;
    denominator: number;
    wilson95: { low: number; high: number } | null;
  };
  labelCoverage: number | null;
}
