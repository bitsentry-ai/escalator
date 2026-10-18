import { randomBytes } from "node:crypto";
import {
  hasCapability,
  deploymentTargetSchema,
  deploymentTokenSchema,
  createDeploymentTargetSchema,
  updateDeploymentTargetSchema,
  issueDeploymentTokenSchema,
  revokeDeploymentTokenSchema,
  deploymentPageSchema,
  deploymentTargetIdSchema,
  deploymentGrantPageInputSchema,
  deploymentGrantSummarySchema,
  type Actor,
  type DeploymentToken,
  type CreateDeploymentTargetInput,
  type UpdateDeploymentTargetInput,
  type IssueDeploymentTokenInput,
} from "../../contracts/index.js";
import { PersistenceError } from "../ports/persistence.js";
import type { DeploymentRepository, DeploymentTransaction } from "./ports.js";
import { deploymentTokenDigest } from "./access.js";
export class DeploymentManagementError extends Error {
  constructor(
    readonly code: "forbidden" | "conflict" | "disabled" | "invalid_responder",
  ) {
    super(code);
  }
}
function authorize(actor: Actor, write: boolean) {
  if (!hasCapability(actor.role, write ? "service:manage" : "deployment:read"))
    throw new DeploymentManagementError("forbidden");
}
function summary(value: DeploymentToken) {
  return deploymentGrantSummarySchema.parse({
    id: value.id,
    targetId: value.targetId,
    capabilities: value.capabilities,
    mappedDeployerId: value.mappedDeployerId,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    revokedAt: value.revokedAt,
  });
}
/** Hosts supply a trusted actor; token plaintext leaves only a committed issuance. */
export class DeploymentManagement {
  constructor(
    private readonly repository: DeploymentRepository,
    private readonly newId: () => string,
  ) {}
  private async audit(
    tx: DeploymentTransaction,
    actor: Actor,
    action: string,
    subjectType: string,
    subjectId: string,
  ) {
    await tx.audit.append({
      id: this.newId(),
      workspaceId: actor.workspaceId,
      actor: { kind: "responder", responderId: actor.responderId },
      action,
      subjectType,
      subjectId,
      recordedAt: await tx.currentTime(),
      metadata: {},
    });
  }
  async list(actor: Actor, input: { after?: string; limit?: number } = {}) {
    authorize(actor, false);
    const query = deploymentPageSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, (tx) =>
      tx.targets.list(query),
    );
  }
  async get(actor: Actor, input: { targetId: string }) {
    authorize(actor, false);
    const { targetId } = deploymentTargetIdSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      const target = await tx.targets.get(targetId);
      if (!target) throw new PersistenceError("not_found");
      return target;
    });
  }
  async create(actor: Actor, input: CreateDeploymentTargetInput) {
    authorize(actor, true);
    const fields = createDeploymentTargetSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      const service = await tx.services.get(fields.serviceId);
      if (!service) throw new PersistenceError("not_found");
      if (fields.enabled && !service.enabled)
        throw new DeploymentManagementError("disabled");
      const at = await tx.currentTime();
      const value = deploymentTargetSchema.parse({
        ...fields,
        id: this.newId(),
        workspaceId: actor.workspaceId,
        revision: 1,
        createdAt: at,
        updatedAt: at,
      });
      await tx.targets.insert(value);
      if (value.enabled) await tx.targets.routing(value.id);
      await this.audit(
        tx,
        actor,
        "deployment.target.created",
        "deployment_target",
        value.id,
      );
      return value;
    });
  }
  async update(actor: Actor, input: UpdateDeploymentTargetInput) {
    authorize(actor, true);
    const { id, expectedRevision, ...fields } =
      updateDeploymentTargetSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      const current = await tx.targets.get(id);
      if (!current) throw new PersistenceError("not_found");
      if (current.revision !== expectedRevision)
        throw new DeploymentManagementError("conflict");
      if (
        fields.enabled &&
        !(await tx.services.get(current.serviceId))?.enabled
      )
        throw new DeploymentManagementError("disabled");
      const value = deploymentTargetSchema.parse({
        ...current,
        ...fields,
        revision: expectedRevision + 1,
        updatedAt: await tx.currentTime(),
      });
      if (!(await tx.targets.replace(value, expectedRevision)))
        throw new DeploymentManagementError("conflict");
      if (value.enabled) await tx.targets.routing(value.id);
      await this.audit(
        tx,
        actor,
        "deployment.target.updated",
        "deployment_target",
        id,
      );
      return value;
    });
  }
  async listTokens(
    actor: Actor,
    input: { targetId: string; after?: string; limit?: number },
  ) {
    authorize(actor, false);
    const { targetId, ...query } = deploymentGrantPageInputSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      const result = await tx.tokens.list(targetId, query);
      return { ...result, items: result.items.map(summary) };
    });
  }
  async issueToken(actor: Actor, input: IssueDeploymentTokenInput) {
    authorize(actor, true);
    const fields = issueDeploymentTokenSchema.parse(input);
    const token = `edp_${randomBytes(32).toString("base64url")}`;
    const grant = await this.repository.transaction(
      actor.workspaceId,
      async (tx) => {
        const target = await tx.targets.get(fields.targetId);
        if (!target) throw new PersistenceError("not_found");
        if (
          !target.enabled ||
          !(await tx.services.get(target.serviceId))?.enabled
        )
          throw new DeploymentManagementError("disabled");
        if (fields.capabilities.includes("deployment:write"))
          await tx.targets.routing(target.id);
        if (fields.mappedDeployerId !== null) {
          const responder = await tx.responders.get(fields.mappedDeployerId);
          if (
            !responder?.enabled ||
            !hasCapability(responder.role, "incident:acknowledge")
          )
            throw new DeploymentManagementError("invalid_responder");
        }
        const at = await tx.currentTime();
        const value = deploymentTokenSchema.parse({
          id: this.newId(),
          workspaceId: actor.workspaceId,
          targetId: target.id,
          tokenHash: deploymentTokenDigest(token)!,
          capabilities: fields.capabilities,
          mappedDeployerId: fields.mappedDeployerId,
          createdAt: at,
          expiresAt: new Date(
            Date.parse(at) + fields.ttlSeconds * 1000,
          ).toISOString(),
          revokedAt: null,
        });
        await tx.tokens.insert(value);
        await this.audit(
          tx,
          actor,
          "deployment.token.issued",
          "deployment_token",
          value.id,
        );
        return summary(value);
      },
    );
    return { ...grant, token };
  }
  async revokeToken(actor: Actor, input: { targetId: string; id: string }) {
    authorize(actor, true);
    const { targetId, id } = revokeDeploymentTokenSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      if (!(await tx.tokens.revoke(targetId, id)))
        throw new PersistenceError("not_found");
      await this.audit(
        tx,
        actor,
        "deployment.token.revoked",
        "deployment_token",
        id,
      );
      return { revoked: true as const };
    });
  }
}
