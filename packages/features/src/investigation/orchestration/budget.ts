import {
  investigationLimitsSchema,
  type InvestigationLimits,
  type InvestigationUsage,
} from "../../contracts/index.js";
import type {
  Budget,
  BudgetResource,
  InvestigationClock,
} from "../ports/index.js";
export class InvestigationBudgetError extends Error {
  constructor(readonly reason: "budget_exhausted" | "cancelled") {
    super("Investigation stopped: " + reason);
  }
}
export const systemInvestigationClock: InvestigationClock = Object.freeze({
  now: () => new Date(),
  monotonicMs: () => performance.now(),
});
/** Per-run accounting; host database time remains authoritative for durable leases. */
export class InvestigationBudget implements Budget {
  readonly limits: Readonly<InvestigationLimits>;
  private readonly capacity: Record<BudgetResource, number>;
  private readonly used: Record<BudgetResource, number> = {
    modelCalls: 0,
    evidenceReads: 0,
    evidenceBytes: 0,
    outputTokens: 0,
    traceEvents: 0,
  };
  private readonly started: number;
  private last: number;
  private clockFailed = false;
  constructor(
    limits: InvestigationLimits,
    private readonly clock: InvestigationClock,
    private readonly signal: AbortSignal,
  ) {
    this.limits = Object.freeze(investigationLimitsSchema.parse(limits));
    this.capacity = {
      modelCalls: this.limits.maxModelCalls,
      evidenceReads: this.limits.maxEvidenceReads,
      evidenceBytes: this.limits.maxEvidenceBytes,
      outputTokens: this.limits.maxOutputTokens,
      traceEvents: this.limits.maxTraceEvents,
    };
    this.started = clock.monotonicMs();
    if (!Number.isFinite(this.started))
      throw new TypeError("Invalid investigation clock");
    this.last = this.started;
  }
  checkpoint(): void {
    if (this.signal.aborted) throw new InvestigationBudgetError("cancelled");
    if (this.remainingMs() <= 0)
      throw new InvestigationBudgetError("budget_exhausted");
  }
  consume(resource: BudgetResource, amount: number): boolean {
    this.checkpoint();
    if (
      !Object.prototype.hasOwnProperty.call(this.used, resource) ||
      !Number.isSafeInteger(amount) ||
      amount < 0
    )
      return false;
    const next = this.used[resource] + amount;
    if (!Number.isSafeInteger(next) || next > this.capacity[resource])
      return false;
    this.used[resource] = next;
    return true;
  }
  remainingMs(): number {
    this.observe();
    return this.clockFailed
      ? 0
      : Math.max(0, this.limits.maxDurationMs - (this.last - this.started));
  }
  snapshot(): InvestigationUsage {
    this.observe();
    return { ...this.used, elapsedMs: this.last - this.started };
  }
  private observe(): void {
    let now: number;
    try {
      now = this.clock.monotonicMs();
    } catch {
      this.clockFailed = true;
      return;
    }
    if (
      !Number.isFinite(now) ||
      now < this.last ||
      !Number.isFinite(now - this.started)
    ) {
      this.clockFailed = true;
      return;
    }
    this.last = now;
  }
}
