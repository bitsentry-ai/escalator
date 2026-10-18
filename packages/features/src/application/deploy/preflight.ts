import { createHash } from "node:crypto";
import {
  deploymentPreflightInputSchema,
  deploymentIdempotencyKeySchema,
  deploymentCoverageQuerySchema,
  overrideDeploymentCoverageSchema,
  deploymentPreflightResultSchema,
  hasCapability,
  type Actor,
  type WorkspaceId,
  type DeploymentTarget,
  type DeploymentCoverageBinding,
  type DeploymentCoverageDecision,
  type DeploymentPreflightResult,
  type ResponderId,
  type DeploymentStartInput,
} from "../../contracts/index.js";
import {
  coverageDecision,
  coverageDecisionState,
  DeploymentPreflightError,
} from "../../domain/deploy/coverage-decision.js";
import { evaluateDeploymentCoverage } from "../../domain/deploy/coverage.js";
import { PersistenceError } from "../ports/persistence.js";
import { DeploymentAccess, type AuthorizedDeployment } from "./access.js";
import { DeploymentCommandError } from "./commands.js";
import { DeploymentManagementError } from "./management.js";
import type {
  CoverageRepository,
  CoverageTransaction,
  CoverageRecord,
} from "./coverage-ports.js";
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function binding(
  target: DeploymentTarget,
  input: { source: string; externalId: string; environmentId: string },
  mappedDeployerId: ResponderId | null,
): DeploymentCoverageBinding {
  if (input.environmentId !== target.environmentId)
    throw new DeploymentPreflightError("scope_violation");
  return {
    workspaceId: target.workspaceId,
    targetId: target.id,
    targetRevision: target.revision,
    policyId: target.policyId,
    serviceId: target.serviceId,
    environmentId: target.environmentId,
    source: input.source,
    externalId: input.externalId,
    mappedDeployerId,
  };
}
type AuditActor = Parameters<
  CoverageTransaction["audit"]["append"]
>[0]["actor"];
export class DeploymentStartCoverageError extends Error {
  constructor(
    readonly reason: DeploymentPreflightResult["reason"] | "missing",
  ) {
    super("coverage_blocked");
  }
}
/** Hosts provide trusted actors/rollout scope. Machine JSON cannot choose identity or override authority. */
export class DeploymentPreflight {
  private readonly access: DeploymentAccess<CoverageTransaction>;
  constructor(
    private readonly repository: CoverageRepository,
    private readonly newId: () => string,
    private readonly allowed: (scope: WorkspaceId) => boolean,
  ) {
    this.access = new DeploymentAccess<CoverageTransaction>(
      repository,
      allowed,
    );
  }
  private authorize(actor: Actor, write: boolean) {
    if (
      (write && !this.allowed(actor.workspaceId)) ||
      !hasCapability(
        actor.role,
        write ? "deployment:override" : "deployment:read",
      )
    )
      throw new DeploymentPreflightError("forbidden");
  }
  private async currentActor(
    tx: CoverageTransaction,
    actor: Actor,
    write: boolean,
  ) {
    const current = await tx.responders.get(actor.responderId);
    if (
      tx.workspaceId !== actor.workspaceId ||
      !current?.enabled ||
      current.workspaceId !== actor.workspaceId ||
      !hasCapability(
        current.role,
        write ? "deployment:override" : "deployment:read",
      )
    )
      throw new DeploymentPreflightError("forbidden");
  }
  private async activeTarget(tx: CoverageTransaction, id: string) {
    const target = await tx.targets.get(id);
    if (!target) throw new PersistenceError("not_found");
    if (!target.enabled || !(await tx.services.get(target.serviceId))?.enabled)
      throw new DeploymentManagementError("disabled");
    return target;
  }
  private async replay(
    tx: CoverageTransaction,
    targetId: string,
    key: string,
    requestHash: string,
  ) {
    const value = await tx.coverage.find(targetId, key);
    if (value && value.requestHash !== requestHash)
      throw new DeploymentCommandError("idempotency_conflict");
    return value;
  }
  private async reply(
    tx: CoverageTransaction,
    proof: DeploymentCoverageDecision,
    currentBinding: DeploymentCoverageBinding,
  ): Promise<DeploymentPreflightResult> {
    const snapshot = await tx.coverage.snapshot(
      currentBinding.targetId,
      currentBinding.mappedDeployerId,
    );
    const at = await tx.currentTime();
    const current = evaluateDeploymentCoverage(snapshot, currentBinding, at);
    const state = coverageDecisionState(proof, currentBinding, current, at);
    let reason: DeploymentPreflightResult["reason"];
    if (state === "expired") reason = "expired";
    else if (state === "stale" || state === "binding_mismatch")
      reason = "stale";
    else if (state === "allow" && proof.override) {
      const actor = await tx.responders.get(proof.override.responderId);
      reason =
        actor?.enabled &&
        actor.workspaceId === tx.workspaceId &&
        hasCapability(actor.role, "deployment:override")
          ? "override"
          : "override_revoked";
    } else reason = current.reason;
    const allow = reason === "declared_coverage" || reason === "override";
    return deploymentPreflightResultSchema.parse({
      decision: allow ? "allow" : "block",
      reason,
      eligibleResponderIds: allow ? current.eligibleResponderIds : [],
      proof,
    });
  }
  private async save(
    tx: CoverageTransaction,
    record: CoverageRecord,
    actor: AuditActor,
    metadata: { tokenId: string | null; previousDecisionId: string | null },
  ) {
    await tx.coverage.insert(record);
    await tx.audit.append({
      id: this.newId(),
      workspaceId: tx.workspaceId,
      actor,
      action: record.decision.override
        ? "deployment.coverage_overridden"
        : "deployment.coverage_evaluated",
      subjectType: "deployment_coverage",
      subjectId: record.decision.id,
      recordedAt: await tx.currentTime(),
      metadata: {
        ...metadata,
        targetId: record.decision.binding.targetId,
        source: record.decision.binding.source,
        externalId: record.decision.binding.externalId,
        decision: record.decision.evaluation.decision,
        reason:
          record.decision.override?.reason ?? record.decision.evaluation.reason,
      },
    });
  }
  /** Invoke inside the authenticated start transaction, never in a second transaction. */
  async requireForStart(
    context: AuthorizedDeployment<CoverageTransaction>,
    input: DeploymentStartInput,
  ): Promise<void> {
    if (input.coverageDecisionId === undefined)
      throw new DeploymentStartCoverageError("missing");
    const { tx, target, grant } = context;
    const record = await tx.coverage.get(target.id, input.coverageDecisionId);
    if (!record) throw new DeploymentStartCoverageError("missing");
    const result = await this.reply(
      tx,
      record.decision,
      binding(target, input, grant.mappedDeployerId),
    );
    if (result.decision !== "allow")
      throw new DeploymentStartCoverageError(result.reason);
  }
  async preflight(
    token: string,
    keyInput: string,
    raw: unknown,
  ): Promise<DeploymentPreflightResult> {
    return this.access.run(
      token,
      "deployment:write",
      async ({ tx, target, grant }) => {
        const input = deploymentPreflightInputSchema.parse(raw),
          key = deploymentIdempotencyKeySchema.parse(keyInput);
        const currentBinding = binding(target, input, grant.mappedDeployerId);
        const requestHash = hash({
          version: 1,
          action: "preflight",
          mappedDeployerId: grant.mappedDeployerId,
          input,
        });
        const previous = await this.replay(tx, target.id, key, requestHash);
        if (previous) return this.reply(tx, previous.decision, currentBinding);
        const snapshot = await tx.coverage.snapshot(
            target.id,
            grant.mappedDeployerId,
          ),
          now = await tx.currentTime();
        const decision = coverageDecision({
          id: this.newId(),
          binding: currentBinding,
          evaluation: evaluateDeploymentCoverage(snapshot, currentBinding, now),
          now,
        });
        await this.save(
          tx,
          { decision, key, requestHash },
          { kind: "system", component: "deployment-preflight" },
          { tokenId: grant.id, previousDecisionId: null },
        );
        return this.reply(tx, decision, currentBinding);
      },
    );
  }
  async get(actor: Actor, raw: unknown): Promise<DeploymentCoverageDecision> {
    this.authorize(actor, false);
    const input = deploymentCoverageQuerySchema.parse(raw);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      await this.currentActor(tx, actor, false);
      const value = await tx.coverage.get(input.targetId, input.decisionId);
      if (!value) throw new PersistenceError("not_found");
      return value.decision;
    });
  }
  async override(
    actor: Actor,
    raw: unknown,
  ): Promise<DeploymentPreflightResult> {
    this.authorize(actor, true);
    const input = overrideDeploymentCoverageSchema.parse(raw);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      await this.currentActor(tx, actor, true);
      const target = await this.activeTarget(tx, input.targetId);
      const original = await tx.coverage.get(target.id, input.decisionId);
      if (!original) throw new PersistenceError("not_found");
      const currentBinding = binding(
        target,
        original.decision.binding,
        original.decision.binding.mappedDeployerId,
      );
      const requestHash = hash({
        version: 1,
        action: "override",
        responderId: actor.responderId,
        decisionId: input.decisionId,
        reason: input.reason,
      });
      const previous = await this.replay(tx, target.id, input.key, requestHash);
      if (previous) return this.reply(tx, previous.decision, currentBinding);
      const snapshot = await tx.coverage.snapshot(
          target.id,
          currentBinding.mappedDeployerId,
        ),
        now = await tx.currentTime();
      const decision = coverageDecision({
        id: this.newId(),
        binding: currentBinding,
        evaluation: evaluateDeploymentCoverage(snapshot, currentBinding, now),
        now,
        override: { actor, reason: input.reason },
      });
      await this.save(
        tx,
        { decision, key: input.key, requestHash },
        { kind: "responder", responderId: actor.responderId },
        { tokenId: null, previousDecisionId: original.decision.id },
      );
      return this.reply(tx, decision, currentBinding);
    });
  }
}
