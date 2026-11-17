import {
  opaqueIdSchema,
  workspaceIdSchema,
  type WorkspaceId,
} from "../../contracts/identity.js";
import {
  ruleProposalClaimSchema,
  ruleCandidateResultSchema,
  type RuleProposalClaim,
  type RuleCandidateResult,
} from "../../contracts/rule-proposal.js";
import {
  ruleCandidateInputSchema,
  type RuleCandidateInput,
} from "../../contracts/rule-candidate-input.js";
import type { RuleProposalClaims } from "./proposal-ports.js";
export interface RuleProposalExecutionPort extends RuleProposalClaims {
  prepare(claim: RuleProposalClaim): Promise<RuleCandidateInput | undefined>;
  complete(
    claim: RuleProposalClaim,
    result: RuleCandidateResult,
  ): Promise<boolean>;
  failed(claim: RuleProposalClaim): Promise<boolean>;
}
export type RuleProposalExecution = (
  claim: RuleProposalClaim,
  input: RuleCandidateInput,
  signal: AbortSignal,
) => Promise<RuleCandidateResult>;
export type RuleProposalExecutionOutcome =
  | "published"
  | "failed"
  | "lease_lost"
  | "stopped"
  | "unavailable"
  | "publication_unknown";
class Interrupted extends Error {}
/** Resource timeouts still belong to host adapters. The race releases the local
 * slot even if a port ignores cancellation; late rejections remain handled. */
async function bounded<T>(
  work: () => Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  const started = performance.now();
  const check = () => {
    if (signal.aborted || performance.now() - started >= timeoutMs)
      throw new Interrupted();
  };
  check();
  let stop = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    stop = () => reject(new Interrupted());
  });
  signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, timeoutMs);
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => {
        check();
        return work();
      }),
      interrupted,
    ]);
    check();
    return result;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
  }
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}
/** Renews the lease every 15 seconds until the signal aborts; a refused or failed renewal loses it. */
async function renewLease(
  port: RuleProposalExecutionPort,
  claim: RuleProposalClaim,
  signal: AbortSignal,
  onLost: () => void,
): Promise<void> {
  while (!signal.aborted) {
    await delay(15000, signal);
    if (signal.aborted) return;
    try {
      if (!(await bounded(() => port.heartbeat(claim), signal, 10000)))
        onLost();
    } catch {
      if (!signal.aborted) onLost();
    }
  }
}
async function reportFailure(
  port: RuleProposalExecutionPort,
  claim: RuleProposalClaim,
  signal: AbortSignal,
): Promise<RuleProposalExecutionOutcome> {
  try {
    return (await bounded(() => port.failed(claim), signal, 10000))
      ? "failed"
      : "lease_lost";
  } catch {
    return "unavailable";
  }
}
/** One model operation, periodically renewed 60-second host lease. Shutdown and
 * uncertain publication never mark work failed after a possible successful commit. */
export async function executeRuleProposalClaim(
  raw: RuleProposalClaim,
  port: RuleProposalExecutionPort,
  execute: RuleProposalExecution,
  parent: AbortSignal,
): Promise<RuleProposalExecutionOutcome> {
  const claim = ruleProposalClaimSchema.parse(raw),
    controller = new AbortController(),
    started = performance.now();
  const abort = () => controller.abort();
  parent.addEventListener("abort", abort, { once: true });
  if (parent.aborted) abort();
  const timer = setTimeout(abort, 60000),
    signal = controller.signal;
  let leaseLost = false,
    publication = false;
  const check = () => {
    if (signal.aborted || performance.now() - started >= 60000)
      throw new Interrupted();
  };
  const renewal = renewLease(port, claim, signal, () => {
    leaseLost = true;
    abort();
  });
  try {
    check();
    const rawInput = await bounded(() => port.prepare(claim), signal, 10000);
    check();
    if (!rawInput) return "unavailable";
    const input = ruleCandidateInputSchema.parse(rawInput);
    if (input.seedVersion.definition.workspaceId !== claim.workspaceId)
      throw new Error("Proposal scope mismatch");
    const result = ruleCandidateResultSchema.parse(
      await bounded(() => execute(claim, input, signal), signal, 35000),
    );
    check();
    publication = true;
    const accepted = await bounded(
      () => port.complete(claim, result),
      signal,
      10000,
    );
    check();
    return accepted ? "published" : "lease_lost";
  } catch {
    if (publication) return "publication_unknown";
    if (parent.aborted) return "stopped";
    if (leaseLost) return "lease_lost";
    if (signal.aborted || performance.now() - started >= 60000)
      return "unavailable";
    return await reportFailure(port, claim, signal);
  } finally {
    abort();
    clearTimeout(timer);
    parent.removeEventListener("abort", abort);
    await renewal;
  }
}
/** One private model slot per host consumer, separate from paging capacity.
 * Concurrent polls coalesce; a fast completion cannot turn one tick into a drain. */
export class RuleProposalConsumer {
  private readonly stopSignal = new AbortController();
  private polling: Promise<void> | undefined;
  private running: Promise<void> | undefined;
  private readonly options: {
    workspaceId: WorkspaceId;
    runtimeId: string;
    token: () => string;
  };
  constructor(
    private readonly port: RuleProposalExecutionPort,
    private readonly execute: RuleProposalExecution,
    options: {
      workspaceId: WorkspaceId;
      runtimeId: string;
      token: () => string;
    },
    private readonly report: (
      state: RuleProposalExecutionOutcome | "claim_failed",
    ) => void = () => {},
  ) {
    this.options = {
      ...options,
      workspaceId: workspaceIdSchema.parse(options.workspaceId),
      runtimeId: opaqueIdSchema.parse(options.runtimeId),
    };
  }
  get active(): number {
    return this.running ? 1 : 0;
  }
  private note(state: RuleProposalExecutionOutcome | "claim_failed") {
    try {
      this.report(state);
    } catch {
      /* Telemetry cannot interrupt ownership. */
    }
  }
  tick(): Promise<void> {
    if (this.stopSignal.signal.aborted || this.running)
      return Promise.resolve();
    if (this.polling) return this.polling;
    this.polling = this.poll().finally(() => {
      this.polling = undefined;
    });
    return this.polling;
  }
  private async poll(): Promise<void> {
    try {
      const raw = await bounded(
        () =>
          this.port.claim({
            ...this.options,
            token: opaqueIdSchema.parse(this.options.token()),
          }),
        this.stopSignal.signal,
        20000,
      );
      if (!raw || this.stopSignal.signal.aborted) return;
      const claim = ruleProposalClaimSchema.parse(raw);
      if (
        claim.workspaceId !== this.options.workspaceId ||
        claim.runtimeId !== this.options.runtimeId
      )
        throw new Error("Proposal claim binding mismatch");
      this.running = executeRuleProposalClaim(
        claim,
        this.port,
        this.execute,
        this.stopSignal.signal,
      )
        .then((state) => this.note(state))
        .catch(() => this.note("unavailable"))
        .finally(() => {
          this.running = undefined;
        });
    } catch {
      if (!this.stopSignal.signal.aborted) this.note("claim_failed");
    }
  }
  async stop(): Promise<void> {
    this.stopSignal.abort();
    await this.polling;
    await this.running;
  }
}
