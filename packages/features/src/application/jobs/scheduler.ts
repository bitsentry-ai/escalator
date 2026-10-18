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
      /** Bounded parallel workers for a dedicated single-kind lane; other lanes retain their slots. */
      jobConcurrency?: Readonly<Record<string, number>>;
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
    const parallel = new Map(
      Object.entries(pollerOptions.jobConcurrency ?? {}),
    );
    for (const [kind, count] of parallel) {
      if (
        !handlers.job.has(kind) ||
        !Number.isSafeInteger(count) ||
        count < 1 ||
        count > 32
      )
        throw new Error("Invalid job concurrency");
      if (!lanes.some((lane) => lane.length === 1 && lane[0] === kind))
        throw new Error("Parallel jobs require a dedicated lane");
    }
    const counts = lanes.map((lane) =>
      lane.length === 1 ? (parallel.get(lane[0]) ?? 1) : 1,
    );
    const workers = counts.reduce((sum, count) => sum + count, 0);
    // Per-kind settings are validated alone; name the combined budget they broke.
    if (workers > 64)
      throw new Error(
        `Job concurrency exceeds the scheduler limit: ${[...parallel].map(([kind, count]) => `${kind} ${count}`).join(" + ")} + ${workers - [...parallel.values()].reduce((sum, count) => sum + count, 0)} other job lanes need ${workers} workers, above 64; lower the probe or metric concurrency setting`,
      );
    const groups: { queue: WorkQueue; handlers: WorkHandlers }[] = [
      ...lanes.flatMap((lane, index) =>
        Array.from({ length: counts[index] }, () => ({
          queue: "job" as const,
          handlers: {
            job: new Map(lane.map((kind) => [kind, handlers.job.get(kind)!])),
            outbox: new Map<string, WorkHandler>(),
          },
        })),
      ),
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
