import type { WorkspaceId } from "../../contracts/index.js";
import type { FoundationRepository } from "../ports/persistence.js";
import { WorkPoller } from "../jobs/poller.js";
import {
  enqueueWatchdog,
  watchdogConfigSchema,
  type WatchdogConfig,
} from "./watchdog.js";
/** This loop only seeds durable intents. Its timer is never evidence of operational health. */
export class WatchdogCoordinator {
  private readonly poller: WorkPoller;
  constructor(
    repository: FoundationRepository,
    scope: WorkspaceId,
    config: WatchdogConfig,
    onError: () => void,
  ) {
    const snapshot = Object.freeze(watchdogConfigSchema.parse(config));
    this.poller = new WorkPoller(
      async () => {
        await enqueueWatchdog(repository, scope, snapshot);
        return "idle";
      },
      { intervalMs: 5000, batchSize: 1, onError },
    );
  }
  start() {
    this.poller.start();
  }
  stop() {
    return this.poller.stop();
  }
}
