import type { RuleSample } from "./rules.js";
import type { IncidentLabel } from "./rule-label.js";
export interface RuleTuningPlan {
  version: 1;
  strategy: "temporal-80-20-with-gap";
  status: "held_out" | "insufficient_span";
  training: { firstDecisionAt: string; lastDecisionAt: string };
  heldOut: { firstDecisionAt: string; lastDecisionAt: string } | null;
  /** Covers the rule language's maximum lookback plus collection delay. */
  gapSeconds: 172800;
}
/** Internal evidence envelope. Provider prompts must still apply redaction and
 * message/token budgets; this port never supplies held-out samples or labels. */
export interface RuleTrainingEvidence {
  plan: RuleTuningPlan;
  cutoffAt: string;
  coverageVerified: false;
  samples: RuleSample[];
  labels: IncidentLabel[];
  excludedSamples: number;
  excludedLabels: number;
}
