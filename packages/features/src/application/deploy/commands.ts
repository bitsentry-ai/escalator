import { createHash } from "node:crypto";
import {
  deploymentStartInputSchema,
  deploymentFinishInputSchema,
  deploymentIdempotencyKeySchema,
  deploymentReceiptResultSchema,
  opaqueIdSchema,
  type Deployment,
  type DeploymentReceipt,
  type DeploymentStartInput,
  type DeploymentFinishInput,
} from "../../contracts/index.js";
import {
  startDeployment,
  finishDeployment,
  type DeploymentTransition,
} from "../../domain/deploy/lifecycle.js";
import { PersistenceError } from "../ports/persistence.js";
import { DeploymentAccess, type AuthorizedDeployment } from "./access.js";
type DeploymentReceiptResult = DeploymentReceipt["result"];
export class DeploymentCommandError extends Error {
  constructor(readonly code: "idempotency_conflict" | "conflict") {
    super(code);
  }
}
function requestHash(
  action: "start" | "finish",
  deploymentId: string | null,
  input: DeploymentStartInput | DeploymentFinishInput,
): string {
  // Zod's strict parsed objects have a fixed field order and canonical timestamps.
  return createHash("sha256")
    .update(JSON.stringify({ version: 1, action, deploymentId, input }))
    .digest("hex");
}
function result(
  decision: DeploymentTransition,
  current?: Deployment,
): DeploymentReceiptResult {
  if (decision.state === "rejected")
    return {
      state: "rejected",
      reason: decision.reason,
      deploymentId: current?.id ?? null,
    };
  const value = decision.state === "changed" ? decision.deployment : current;
  if (
    !value ||
    (decision.state !== "changed" &&
      (decision.state !== "unchanged" || decision.reason !== "duplicate"))
  )
    throw new Error("Unexpected deploy command transition");
  return {
    state: decision.state === "changed" ? "accepted" : "duplicate",
    deploymentId: value.id,
    revision: value.revision,
    status: value.status,
  };
}
/** Pure lifecycle, command receipt and audit commit together after live authentication. */
export class DeploymentCommands {
  constructor(
    private readonly access: DeploymentAccess,
    private readonly newId: () => string,
  ) {}
  private async replay(
    context: AuthorizedDeployment,
    key: string,
    hash: string,
  ) {
    const receipt = await context.tx.receipts.get(context.target.id, key);
    if (!receipt) return undefined;
    if (receipt.requestHash !== hash)
      throw new DeploymentCommandError("idempotency_conflict");
    return receipt.result;
  }
  private async record(
    context: AuthorizedDeployment,
    key: string,
    hash: string,
    action: "start" | "finish",
    value: DeploymentReceiptResult,
  ) {
    const { tx, target, grant } = context;
    const stored = deploymentReceiptResultSchema.parse(value);
    const recordedAt = await tx.currentTime();
    // Chronology depends on database time, so an identical retry is re-evaluated.
    if (stored.state !== "rejected" || stored.reason !== "chronology")
      await tx.receipts.insert({
        workspaceId: tx.workspaceId,
        targetId: target.id,
        tokenId: grant.id,
        key,
        requestHash: hash,
        action,
        result: stored,
        recordedAt,
      });
    await tx.audit.append({
      id: this.newId(),
      workspaceId: tx.workspaceId,
      actor: { kind: "system", component: "deployment-ingress" },
      action: `deployment.${action}.${stored.state}`,
      subjectType: "deployment_target",
      subjectId: target.id,
      recordedAt,
      metadata: {
        tokenId: grant.id,
        deploymentId: stored.deploymentId,
        state: stored.state,
        reason: stored.state === "rejected" ? stored.reason : null,
      },
    });
    return stored;
  }
  async start(
    token: string,
    keyInput: string,
    raw: unknown,
  ): Promise<DeploymentReceiptResult> {
    return this.access.run(token, "deployment:write", async (context) => {
      const { tx, target, grant, now } = context;
      const input = deploymentStartInputSchema.parse(raw),
        key = deploymentIdempotencyKeySchema.parse(keyInput);
      const hash = requestHash("start", null, input),
        replay = await this.replay(context, key, hash);
      if (replay) return replay;
      const previous = await tx.deployments.find(
        target.id,
        input.source,
        input.externalId,
      );
      const decision = startDeployment(
        previous?.deployment,
        input,
        {
          id: previous?.deployment.id ?? this.newId(),
          workspaceId: tx.workspaceId,
          serviceId: target.serviceId,
          environmentId: target.environmentId,
          tokenId: grant.id,
          mappedDeployerId: grant.mappedDeployerId,
          timeoutSeconds: target.timeoutSeconds,
        },
        now,
      );
      if (decision.state === "changed")
        await tx.deployments.insert({
          targetId: target.id,
          deployment: decision.deployment,
          policy: await tx.targets.routing(target.id),
        });
      return this.record(
        context,
        key,
        hash,
        "start",
        result(decision, previous?.deployment),
      );
    });
  }
  async finish(
    token: string,
    idInput: string,
    keyInput: string,
    raw: unknown,
  ): Promise<DeploymentReceiptResult> {
    return this.access.run(token, "deployment:write", async (context) => {
      const { tx, target, now } = context;
      const id = opaqueIdSchema.parse(idInput),
        input = deploymentFinishInputSchema.parse(raw),
        key = deploymentIdempotencyKeySchema.parse(keyInput);
      const hash = requestHash("finish", id, input),
        replay = await this.replay(context, key, hash);
      if (replay) return replay;
      const previous = await tx.deployments.get(target.id, id);
      const decision = finishDeployment(previous?.deployment, input, now);
      if (decision.state === "changed") {
        if (
          !previous ||
          !(await tx.deployments.replace(
            target.id,
            decision.deployment,
            previous.deployment.revision,
          ))
        )
          throw new DeploymentCommandError("conflict");
      }
      return this.record(
        context,
        key,
        hash,
        "finish",
        result(decision, previous?.deployment),
      );
    });
  }
  async get(token: string, idInput: string): Promise<Deployment> {
    return this.access.run(token, "deployment:read", async ({ tx, target }) => {
      const value = await tx.deployments.get(
        target.id,
        opaqueIdSchema.parse(idInput),
      );
      if (!value) throw new PersistenceError("not_found");
      return value.deployment;
    });
  }
}
