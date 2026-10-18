import { workspaceIdSchema, type WorkspaceId } from "../../contracts/index.js";
import { WorkPoller } from "../jobs/poller.js";
import type { WorkHandlers } from "../jobs/scheduler.js";
import {
  initializeRetentionMaintenance,
  retentionMaintenanceKind,
  type RetentionMaintenanceRepository,
  type RetentionMaintenanceJobs,
} from "./maintenance.js";
/** One shared host instance; excess maintenance/coverage calls never queue in the DB pool. */
export class MaintenanceAdmission {
  private active = false;
  private settled: Promise<void> = Promise.resolve();
  drain(): Promise<void> {
    return this.settled;
  }
  async tryRun<T>(
    run: () => Promise<T>,
  ): Promise<{ accepted: false } | { accepted: true; value: T }> {
    if (this.active) return { accepted: false };
    this.active = true;
    let release!: () => void;
    this.settled = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      return { accepted: true, value: await run() };
    } finally {
      this.active = false;
      release();
    }
  }
}
export const retentionJobLane: readonly string[] = Object.freeze([
  retentionMaintenanceKind,
]);
export function withRetentionHandlers(
  handlers: WorkHandlers,
  jobs: Pick<RetentionMaintenanceJobs, "run">,
  admission: MaintenanceAdmission,
): WorkHandlers {
  if (handlers.job.has(retentionMaintenanceKind))
    throw new Error("Retention handler already registered");
  return {
    ...handlers,
    job: new Map([
      ...handlers.job,
      [
        retentionMaintenanceKind,
        async (lease, signal) => {
          if (signal.aborted) return { state: "stale" };
          const result = await admission.tryRun(() => jobs.run(lease, signal));
          // Capacity waits do not consume the durable job's finite failure budget.
          return result.accepted
            ? result.value
            : { state: "wait", delayMs: 5000 };
        },
      ],
    ]),
  };
}
/** One process-level coordinator traverses trusted scopes; a broken/busy scope cannot pin it. */
export class RetentionCoordinator {
  private readonly scopes: readonly WorkspaceId[];
  private readonly poller: WorkPoller;
  private position = 0;
  constructor(
    private readonly repository: RetentionMaintenanceRepository,
    scopes: readonly WorkspaceId[],
    private readonly admission: MaintenanceAdmission,
    onError: () => void,
  ) {
    if (scopes.length > 100 || new Set(scopes).size !== scopes.length)
      throw new Error("Invalid maintenance scope set");
    this.scopes = Object.freeze(
      scopes.map((scope) => workspaceIdSchema.parse(scope)),
    );
    this.poller = new WorkPoller(
      async () => {
        await this.tick();
        return "idle";
      },
      { intervalMs: 5000, batchSize: 1, onError },
    );
  }
  async tick(): Promise<void> {
    const scope = this.scopes[this.position];
    if (scope === undefined) return;
    this.position = (this.position + 1) % this.scopes.length;
    await this.admission.tryRun(() =>
      initializeRetentionMaintenance(this.repository, scope),
    );
  }
  start(): void {
    if (this.scopes.length) this.poller.start();
  }
  stop(): Promise<void> {
    return this.poller.stop();
  }
}

export interface RetentionRuntimeResources {
  readonly repository: RetentionMaintenanceRepository;
  readonly admission: MaintenanceAdmission;
}
