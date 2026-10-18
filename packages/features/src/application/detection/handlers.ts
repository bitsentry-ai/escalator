import type { WorkHandlers } from "../jobs/scheduler.js";
import type { WorkHandler } from "../jobs/runner.js";
import type { DetectionRepository } from "./ports.js";
import { SignalProcessing } from "./process.js";
import { SignalRecovery } from "./recovery.js";
/** Separate recovery capacity prevents a signal storm from starving due holds. */
export const detectionJobLanes = [
  ["signal.process"],
  ["signal.recover"],
] as const;
export function createDetectionHandlers(
  repository: DetectionRepository,
): WorkHandlers {
  const processing = new SignalProcessing(repository);
  const recovery = new SignalRecovery(repository);
  return {
    job: new Map<string, WorkHandler>([
      ["signal.process", (lease) => processing.process(lease)],
      ["signal.recover", (lease) => recovery.recover(lease)],
    ]),
    outbox: new Map(),
  };
}
