import {
  workspaceIdSchema,
  opaqueIdSchema,
  type WorkspaceId,
} from "../../contracts/index.js";
import type { InvestigationRepository } from "../ports/index.js";
import {
  executeInvestigationClaim,
  type InvestigationExecution,
  type InvestigationExecutionOutcome,
} from "./lease-runner.js";
export interface InvestigationConsumerOptions {
  workspaceId: WorkspaceId;
  runtimeId: string;
  concurrency: number;
  token(): string;
}
/** Host supplies a bounded claim adapter and a private polling timer. Paging has its own
 * queue consumer, connections and capacity. No run can increase these local slots. */
export class InvestigationConsumer {
  private readonly options: InvestigationConsumerOptions;
  private readonly cancellation = new AbortController();
  private readonly running = new Set<Promise<void>>();
  private polling: Promise<void> | undefined;
  constructor(
    private readonly repository: Pick<
      InvestigationRepository,
      "claim" | "heartbeat" | "publish"
    >,
    private readonly execute: InvestigationExecution,
    options: InvestigationConsumerOptions,
    private readonly report: (
      state: InvestigationExecutionOutcome["state"] | "claim_failed",
    ) => void = () => {},
  ) {
    workspaceIdSchema.parse(options.workspaceId);
    opaqueIdSchema.parse(options.runtimeId);
    if (
      !Number.isInteger(options.concurrency) ||
      options.concurrency < 1 ||
      options.concurrency > 4
    )
      throw new Error("Invalid investigation concurrency");
    this.options = { ...options };
  }
  get active(): number {
    return this.running.size;
  }
  /** Resolves after bounded claiming, not after model execution. Concurrent ticks coalesce. */
  tick(): Promise<void> {
    if (this.cancellation.signal.aborted) return Promise.resolve();
    if (this.polling) return this.polling;
    this.polling = this.poll().finally(() => {
      this.polling = undefined;
    });
    return this.polling;
  }
  private note(state: InvestigationExecutionOutcome["state"] | "claim_failed") {
    try {
      this.report(state);
    } catch {
      /* Operational telemetry cannot terminate queue ownership. */
    }
  }
  private async poll() {
    const slots = this.options.concurrency - this.running.size;
    // A fixed initial slot count prevents a fast completion from turning one tick into an unbounded drain.
    for (
      let index = 0;
      index < slots && !this.cancellation.signal.aborted;
      index++
    ) {
      let claim;
      try {
        claim = await this.repository.claim({
          workspaceId: this.options.workspaceId,
          runtimeId: this.options.runtimeId,
          claimToken: opaqueIdSchema.parse(this.options.token()),
          leaseMs: 30000,
        });
      } catch {
        this.note("claim_failed");
        return;
      }
      if (!claim || this.cancellation.signal.aborted) return;
      if (
        claim.scope.workspaceId !== this.options.workspaceId ||
        claim.runtimeId !== this.options.runtimeId
      ) {
        this.note("claim_failed");
        return;
      }
      const run: Promise<void> = executeInvestigationClaim(
        claim,
        this.repository,
        this.execute,
        this.cancellation.signal,
      )
        .then(
          (outcome) => {
            this.note(outcome.state);
          },
          () => {
            this.note("execution_failed");
          },
        )
        .finally(() => {
          this.running.delete(run);
        });
      this.running.add(run);
    }
  }
  async stop(): Promise<void> {
    this.cancellation.abort();
    await this.polling;
    await Promise.allSettled([...this.running]);
  }
}
