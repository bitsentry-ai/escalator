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
      /** Each registered job kind occurs once; independent loops reserve deadline capacity. */
      jobLanes?: readonly (readonly string[])[];
    },
  ) {
    const lanes = pollerOptions.jobLanes ?? [[...handlers.job.keys()]];
    const kinds = lanes.flat();
    if (
      lanes.length < 1 ||
      lanes.length > 16 ||
      (pollerOptions.jobLanes && lanes.some((lane) => lane.length === 0)) ||
      new Set(kinds).size !== kinds.length ||
      kinds.length !== handlers.job.size ||
      kinds.some((kind) => !handlers.job.has(kind))
    )
      throw new Error("Job lanes must partition registered handlers");
    const groups: { queue: WorkQueue; handlers: WorkHandlers }[] = [
      ...lanes.map((lane) => ({
        queue: "job" as const,
        handlers: {
          job: new Map(lane.map((kind) => [kind, handlers.job.get(kind)!])),
          outbox: new Map<string, WorkHandler>(),
        },
      })),
      {
        queue: "outbox",
        handlers: { job: new Map(), outbox: handlers.outbox },
      },
    ];
    this.loops = groups.map((group) => {
      const runner = new DurableWorkRunner(
        store,
        group.handlers,
        runnerOptions,
      );
      return new WorkPoller(() => runner.runOne(workspaceId, group.queue), {
        ...pollerOptions,
        onError: () => pollerOptions.onError(group.queue),
      });
    });
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
