import type { RuleTransition } from "../../contracts/rule-state.js";
import type { RuleBacktestReport } from "../../contracts/rule-backtest.js";
/** Caller validates a contiguous sequence first. Adjacent unavailable decisions
 * are grouped by reason; no silence or suppressed interval counts as healthy. */
export function backtestAvailability(
  decisions: readonly RuleTransition[],
): RuleBacktestReport["availability"] {
  const available: RuleBacktestReport["availability"]["available"] = [],
    gaps: RuleBacktestReport["availability"]["gaps"] = [];
  let priorReason: string | undefined;
  for (const d of decisions) {
    const usable =
      d.status === "evaluated" &&
      d.verdict !== null &&
      d.verdict.state !== "insufficient_data";
    let reason = d.verdict?.reason ?? "unknown";
    if (usable) reason = "available";
    else if (d.status === "suppressed") reason = "suppressed";
    const at = d.state.lastDecisionAt;
    if (reason === priorReason) {
      const last = usable
        ? available[available.length - 1]
        : gaps[gaps.length - 1].range;
      last.lastDecisionAt = at;
      last.decisions++;
    } else {
      const range = { firstDecisionAt: at, lastDecisionAt: at, decisions: 1 };
      if (usable) available.push(range);
      else gaps.push({ range, reason });
    }
    priorReason = reason;
  }
  return {
    semantics: "decision_windows",
    firstUsableDecisionAt: available[0]?.firstDecisionAt ?? null,
    lastUsableDecisionAt: available.at(-1)?.lastDecisionAt ?? null,
    available,
    gaps,
  };
}
