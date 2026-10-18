import {
  defaultReplayRetention,
  replayRetentionSettingsSchema,
  replayRetentionPolicySchema,
  updateReplayRetentionSchema,
  hasCapability,
  type Actor,
  type WorkspaceId,
  type ReplayRetentionSettings,
  type ReplayRetentionPolicy,
  type UpdateReplayRetention,
} from "../../contracts/index.js";
import {
  PersistenceError,
  type FoundationTransaction,
} from "../ports/persistence.js";
/** Host implementations serialize policy writes with the workspace accounting lock.
 * They must never acquire a source lock after taking that accounting lock.
 */
export interface RetentionPolicyTransaction extends FoundationTransaction {
  retentionPolicy: {
    get(): Promise<ReplayRetentionPolicy | undefined>;
    put(
      policy: ReplayRetentionPolicy,
      expectedVersion: number | null,
    ): Promise<boolean>;
  };
}
export interface RetentionPolicyRepository {
  transaction<T>(
    scope: WorkspaceId,
    work: (tx: RetentionPolicyTransaction) => Promise<T>,
  ): Promise<T>;
}
export class RetentionManagementError extends Error {
  constructor(readonly code: "forbidden" | "conflict" | "capacity") {
    super(code);
  }
}
/** Deployment-controlled ceilings. Request bodies cannot override these limits. */
export const defaultRetentionCeilings: Readonly<ReplayRetentionSettings> =
  Object.freeze({ days: 365, maxBytes: 5 * 1024 ** 3 });
export function effectiveRetention(
  settings: ReplayRetentionSettings,
  limits: ReplayRetentionSettings,
): ReplayRetentionSettings {
  const configured = replayRetentionSettingsSchema.parse({
      days: settings.days,
      maxBytes: settings.maxBytes,
    }),
    ceiling = replayRetentionSettingsSchema.parse(limits);
  return {
    days: Math.min(configured.days, ceiling.days),
    maxBytes: Math.min(configured.maxBytes, ceiling.maxBytes),
  };
}
export class RetentionPolicyManagement {
  private readonly limits: Readonly<ReplayRetentionSettings>;
  constructor(
    private readonly repository: RetentionPolicyRepository,
    private readonly newId: () => string,
    limits: ReplayRetentionSettings = { ...defaultRetentionCeilings },
  ) {
    this.limits = Object.freeze(replayRetentionSettingsSchema.parse(limits));
  }
  private policy(value: ReplayRetentionPolicy | undefined, scope: WorkspaceId) {
    if (!value) return null;
    const parsed = replayRetentionPolicySchema.parse(value);
    if (parsed.workspaceId !== scope)
      throw new PersistenceError("scope_violation");
    return parsed;
  }
  async get(actor: Actor) {
    if (!hasCapability(actor.role, "service:read"))
      throw new RetentionManagementError("forbidden");
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      const configured = this.policy(
        await tx.retentionPolicy.get(),
        actor.workspaceId,
      );
      return {
        configured,
        effective: effectiveRetention(
          configured ?? defaultReplayRetention,
          this.limits,
        ),
        limits: { ...this.limits },
      };
    });
  }
  async save(actor: Actor, raw: UpdateReplayRetention) {
    if (!hasCapability(actor.role, "service:manage"))
      throw new RetentionManagementError("forbidden");
    const input = updateReplayRetentionSchema.parse(raw);
    if (input.days > this.limits.days || input.maxBytes > this.limits.maxBytes)
      throw new RetentionManagementError("capacity");
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      const previous = this.policy(
        await tx.retentionPolicy.get(),
        actor.workspaceId,
      );
      if (
        (previous?.version ?? null) !== input.expectedVersion ||
        previous?.version === Number.MAX_SAFE_INTEGER
      )
        throw new RetentionManagementError("conflict");
      const policy = replayRetentionPolicySchema.parse({
        workspaceId: actor.workspaceId,
        version: (previous?.version ?? 0) + 1,
        days: input.days,
        maxBytes: input.maxBytes,
        updatedAt: tx.now,
      });
      if (!(await tx.retentionPolicy.put(policy, input.expectedVersion)))
        throw new RetentionManagementError("conflict");
      await tx.audit.append({
        id: this.newId(),
        workspaceId: actor.workspaceId,
        actor: { kind: "responder", responderId: actor.responderId },
        action: "retention.policy.updated",
        subjectType: "workspace",
        subjectId: actor.workspaceId,
        recordedAt: tx.now,
        metadata: {
          version: policy.version,
          previousVersion: previous?.version ?? null,
          days: policy.days,
          maxBytes: policy.maxBytes,
        },
      });
      return {
        configured: policy,
        effective: effectiveRetention(policy, this.limits),
        limits: { ...this.limits },
      };
    });
  }
}
