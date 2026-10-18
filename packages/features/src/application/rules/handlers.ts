import { RuleProposalEvaluation } from "./proposal-evaluation.js";
import type { RuleProposalRepository } from "./proposal-ports.js";
import type { RuleBacktestRepository } from "./backtest-ports.js";
import { RuleBacktestExecution } from "./backtest-job.js";
import type { RuleReplayRepository } from "./replay-ports.js";
import { RuleReplayExecution } from "./replay-job.js";
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

export const ruleReplayLane = ["rules.replay"] as const;
export function withRuleReplayHandlers(
  handlers: WorkHandlers,
  repository: RuleReplayRepository,
): WorkHandlers {
  if (handlers.job.has("rules.replay"))
    throw new Error("Replay handler already registered");
  const runner = new RuleReplayExecution(repository);
  return {
    job: new Map<string, WorkHandler>([
      ...handlers.job,
      ["rules.replay", (lease) => runner.process(lease)],
    ]),
    outbox: handlers.outbox,
  };
}

export const ruleBacktestLane = ["rules.backtest"] as const;
export function withRuleBacktestHandlers(
  handlers: WorkHandlers,
  repository: RuleBacktestRepository,
): WorkHandlers {
  if (handlers.job.has("rules.backtest"))
    throw new Error("Backtest handler already registered");
  const runner = new RuleBacktestExecution(repository);
  return {
    job: new Map<string, WorkHandler>([
      ...handlers.job,
      ["rules.backtest", (lease) => runner.process(lease)],
    ]),
    outbox: handlers.outbox,
  };
}

export const ruleProposalEvaluationLane = ["rules.proposal-evaluate"] as const;
export function withRuleProposalEvaluationHandlers(
  handlers: WorkHandlers,
  repository: RuleProposalRepository,
): WorkHandlers {
  if (handlers.job.has("rules.proposal-evaluate"))
    throw new Error("Proposal evaluation handler already registered");
  const runner = new RuleProposalEvaluation(repository);
  return {
    job: new Map<string, WorkHandler>([
      ...handlers.job,
      ["rules.proposal-evaluate", (lease) => runner.process(lease)],
    ]),
    outbox: handlers.outbox,
  };
}
