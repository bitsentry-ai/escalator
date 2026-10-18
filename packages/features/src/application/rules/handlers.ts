import type { WorkHandlers } from "../jobs/scheduler.js";
import type { WorkHandler } from "../jobs/runner.js";
import type { RuleLiveRepository } from "./live-ports.js";
import { LiveRuleEvaluation } from "./live.js";
export const ruleEvaluationLane = ["rules.evaluate"] as const;
export function withRuleEvaluationHandlers(
  handlers: WorkHandlers,
  repository: RuleLiveRepository,
): WorkHandlers {
  if (handlers.job.has("rules.evaluate"))
    throw new Error("Rule handler already registered");
  const runner = new LiveRuleEvaluation(repository);
  return {
    job: new Map<string, WorkHandler>([
      ...handlers.job,
      ["rules.evaluate", (lease) => runner.process(lease)],
    ]),
    outbox: handlers.outbox,
  };
}
