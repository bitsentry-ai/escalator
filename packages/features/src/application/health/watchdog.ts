import { createHash } from "node:crypto";
import { z } from "zod";
import {
  opaqueIdSchema,
  utcTimestampSchema,
  webhookCredentialsSchema,
  type WorkspaceId,
} from "../../contracts/index.js";
import type { FoundationRepository } from "../ports/persistence.js";
import type { SecretStore } from "../ports/secrets.js";
import type { WorkLease } from "../jobs/ports.js";
import type { WorkHandlerResult } from "../jobs/runner.js";
import type { ChannelHttpTransport } from "../../adapters/channels/ports.js";
import { decodeChannelSecret } from "../../adapters/channels/validation.js";
import type { OperationalHealthCheck } from "./health.js";
export const watchdogConfigSchema = z.strictObject({
  secretId: opaqueIdSchema,
  intervalSeconds: z.number().int().min(30).max(300).default(60),
});
export type WatchdogConfig = z.infer<typeof watchdogConfigSchema>;
const payloadSchema = z.strictObject({
  signature: z.string().regex(/^[a-f0-9]{64}$/),
  bucketAt: utcTimestampSchema,
  secretIds: z.array(opaqueIdSchema).length(1),
});
export const watchdogJobPrefix = "health.watchdog.";
/** Different deployment configurations cannot consume one another’s heartbeat intents. */
export function watchdogJobKind(
  scope: WorkspaceId,
  config: WatchdogConfig,
): string {
  return watchdogJobPrefix + signature(scope, config);
}
function signature(scope: WorkspaceId, config: WatchdogConfig) {
  return createHash("sha256")
    .update(JSON.stringify([scope, config.secretId, config.intervalSeconds]))
    .digest("hex");
}
function id(hash: string, at: string) {
  return `watchdog-${hash}-${Date.parse(at)}`;
}
/** No URL or token enters durable work; replicas share a deterministic database-time bucket. */
export async function enqueueWatchdog(
  repository: FoundationRepository,
  scope: WorkspaceId,
  config: WatchdogConfig,
): Promise<void> {
  const validated = watchdogConfigSchema.parse(config);
  await repository.transaction(scope, async (tx) => {
    const interval = validated.intervalSeconds * 1000;
    const bucketAt = new Date(
      Math.floor(Date.parse(tx.now) / interval) * interval,
    ).toISOString();
    const hash = signature(scope, validated),
      jobId = id(hash, bucketAt);
    await tx.work.enqueue("job", {
      id: jobId,
      idempotencyKey: jobId,
      kind: watchdogJobKind(scope, validated),
      dueAt: tx.now,
      payload: { signature: hash, bucketAt, secretIds: [validated.secretId] },
    });
  });
}
export type WatchdogOutcome = "accepted" | "unknown" | "suppressed";
/** The handler checks health after decrypting, immediately before the outbound operation. */
export class WatchdogJobs {
  private readonly config: Readonly<WatchdogConfig>;
  readonly kind: string;
  readonly lane: readonly string[];
  constructor(
    private readonly repository: FoundationRepository,
    private readonly scope: WorkspaceId,
    config: WatchdogConfig,
    private readonly health: Pick<OperationalHealthCheck, "check">,
    private readonly secrets: SecretStore,
    private readonly http: ChannelHttpTransport,
    private readonly observe: (result: WatchdogOutcome) => void = () => {
      /* Optional observer. */
    },
  ) {
    this.config = Object.freeze(watchdogConfigSchema.parse(config));
    this.kind = watchdogJobKind(scope, this.config);
    this.lane = Object.freeze([this.kind]);
  }
  private async current(
    lease: WorkLease,
  ): Promise<"ready" | "obsolete" | "stale"> {
    if (lease.workspaceId !== this.scope)
      throw new Error("Invalid watchdog scope");
    return this.repository.transaction(this.scope, async (tx) => {
      const claim = await tx.work.lockClaim(lease);
      if (!claim) return "stale";
      if (claim.queue !== "job" || claim.kind !== this.kind)
        throw new Error("Invalid watchdog claim");
      const payload = payloadSchema.parse(claim.payload);
      const config = this.config;
      const hash = signature(this.scope, config);
      const interval = config.intervalSeconds * 1000,
        at = Date.parse(payload.bucketAt),
        now = Date.parse(tx.now);
      if (
        payload.signature !== hash ||
        payload.secretIds[0] !== config.secretId ||
        claim.id !== id(hash, payload.bucketAt) ||
        at % interval !== 0 ||
        now < at ||
        now >= at + interval
      )
        return "obsolete";
      return "ready";
    });
  }
  async run(lease: WorkLease, signal: AbortSignal): Promise<WorkHandlerResult> {
    if (signal.aborted) return { state: "stale" };
    const current = await this.current(lease);
    if (current === "stale" || signal.aborted) return { state: "stale" };
    if (current === "obsolete") return { state: "completed" };
    let outcome: WatchdogOutcome = "unknown";
    try {
      await this.secrets.withSecret(
        {
          workspaceId: this.scope,
          queue: "job",
          workId: lease.id,
          claimToken: lease.token,
          secretId: this.config.secretId,
          signal,
        },
        async (bytes) => {
          const credentials = decodeChannelSecret(
            bytes,
            webhookCredentialsSchema,
          );
          if (!credentials) throw new Error("Invalid watchdog credential");
          const health = await this.health.check();
          if (!health.ready || signal.aborted) {
            outcome = "suppressed";
            return;
          }
          // Recheck the persisted fence after any broker/health latency, before network I/O.
          if ((await this.current(lease)) !== "ready" || signal.aborted) {
            outcome = "suppressed";
            return;
          }
          const result = await this.http.send({
            url: credentials.url,
            method: "GET",
            headers: credentials.bearerToken
              ? { authorization: `Bearer ${credentials.bearerToken}` }
              : {},
            signal,
          });
          if (!signal.aborted && result.status >= 200 && result.status < 300)
            outcome = "accepted";
        },
      );
    } catch {
      outcome = "unknown";
    }
    try {
      this.observe(outcome);
    } catch {
      /* Diagnostic sinks never control durable progress. */
    }
    return { state: "completed" };
  }
}
