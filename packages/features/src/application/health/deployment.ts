import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { defaultHealthPolicy, type HealthPolicy } from "./health.js";
import { watchdogConfigSchema, type WatchdogConfig } from "./watchdog.js";
const policySchema = z.strictObject({
  queryTimeoutMs: z.number().int().min(1).max(5000).optional(),
  maxSchedulerAgeMs: z.number().int().min(1000).max(300000).optional(),
  maxPagingLagMs: z.number().int().min(1000).max(300000).optional(),
  maxJobLagMs: z.number().int().min(1000).max(3600000).optional(),
});
const deploymentSchema = z.strictObject({
  readinessTokenSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  limits: policySchema.optional(),
  watchdog: watchdogConfigSchema.optional(),
});
/** Trusted deployment configuration. Never accepts a token from application input. */
export class HealthDeployment {
  readonly policy: Readonly<HealthPolicy>;
  readonly watchdog: Readonly<WatchdogConfig> | undefined;
  private readonly digest: Buffer | undefined;
  constructor(input: unknown = {}) {
    try {
      const parsed = deploymentSchema.parse(input);
      this.policy = Object.freeze({
        queryTimeoutMs:
          parsed.limits?.queryTimeoutMs ?? defaultHealthPolicy.queryTimeoutMs,
        maxSchedulerAgeMs:
          parsed.limits?.maxSchedulerAgeMs ??
          defaultHealthPolicy.maxSchedulerAgeMs,
        maxPagingLagMs:
          parsed.limits?.maxPagingLagMs ?? defaultHealthPolicy.maxPagingLagMs,
        maxJobLagMs:
          parsed.limits?.maxJobLagMs ?? defaultHealthPolicy.maxJobLagMs,
      });
      this.watchdog = parsed.watchdog
        ? Object.freeze({ ...parsed.watchdog })
        : undefined;
      this.digest = parsed.readinessTokenSha256
        ? Buffer.from(parsed.readinessTokenSha256, "hex")
        : undefined;
    } catch {
      throw new Error("Invalid operational health configuration");
    }
  }
  static fromJSON(value?: string): HealthDeployment {
    if (!value) return new HealthDeployment();
    try {
      if (Buffer.byteLength(value) > 8192)
        throw new Error("configuration exceeds 8 KiB");
      return new HealthDeployment(JSON.parse(value));
    } catch {
      throw new Error("Invalid operational health configuration");
    }
  }
  authorized(authorization: string | undefined): boolean {
    // Operator-generated 32-byte base64url capability; no query/cookie fallback.
    if (
      typeof authorization !== "string" ||
      !/^Bearer [A-Za-z0-9_-]{43}$/i.test(authorization)
    )
      return false;
    const actual = createHash("sha256").update(authorization.slice(7)).digest();
    return (
      timingSafeEqual(actual, this.digest ?? Buffer.alloc(32)) &&
      this.digest !== undefined
    );
  }
}
