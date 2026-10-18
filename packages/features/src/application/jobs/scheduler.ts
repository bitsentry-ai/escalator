import type { WorkspaceId } from "../../contracts/index.js";
import type { DurableWorkStore, WorkQueue } from "./ports.js";
import {
  DurableWorkRunner,
  type RunnerOptions,
  type WorkHandler,
} from "./runner.js";
import { WorkPoller, type PollerOptions } from "./poller.js";
export type WorkHandlers = Readonly<
  Record<WorkQueue, ReadonlyMap<string, WorkHandler>>
>;
/** Host owns identity, database and lifetime; both queues use the same durable protocol. */
export class DurableWorkScheduler {
  private readonly loops: WorkPoller[];
  private stopping: Promise<void> | undefined;
  constructor(
    store: DurableWorkStore,
    workspaceId: WorkspaceId,
    handlers: WorkHandlers,
    runnerOptions: RunnerOptions,
    pollerOptions: Omit<PollerOptions, "onError"> & {
      onError(queue: WorkQueue): void;
    },
  ) {
    const runner = new DurableWorkRunner(store, handlers, runnerOptions);
    this.loops = (["job", "outbox"] as const).map(
      (queue) =>
        new WorkPoller(() => runner.runOne(workspaceId, queue), {
          ...pollerOptions,
          onError: () => pollerOptions.onError(queue),
        }),
    );
  }
  start(): void {
    if (this.stopping) throw new Error("Work scheduler is stopping");
    for (const loop of this.loops) loop.start();
  }
  stop(): Promise<void> {
    if (!this.stopping)
      this.stopping = Promise.all(this.loops.map((loop) => loop.stop()))
        .then(() => undefined)
        .finally(() => {
          this.stopping = undefined;
        });
    return this.stopping;
  }
}
