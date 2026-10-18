import {
  deploymentTargetSchema,
  deploymentTokenSchema,
  deploymentEntrySchema,
  deploymentReceiptSchema,
  deploymentIdempotencyKeySchema,
  deploymentSchema,
  configuredPolicySchema,
  policyDefinition,
  opaqueIdSchema,
  utcTimestampSchema,
  type DeploymentTarget,
  type DeploymentEntry,
} from "../../contracts/index.js";
import {
  PersistenceError,
  type FoundationTransaction,
  type PageRequest,
} from "../ports/persistence.js";
import type { TransactionGuard } from "../ports/transaction-guard.js";
import type { DeploymentRecordStore, DeploymentTransaction } from "./ports.js";
import {
  startDeployment,
  finishDeployment,
  timeoutDeployment,
} from "../../domain/deploy/lifecycle.js";

export class DeploymentPersistenceError extends Error {
  constructor(
    readonly code:
      | "invalid_version"
      | "identity_change"
      | "invalid_timestamp"
      | "invalid_transition"
      | "invalid_receipt",
  ) {
    super(code);
  }
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new PersistenceError("not_found");
  return value;
}
function page(value: PageRequest): void {
  if (
    !Number.isInteger(value.limit) ||
    value.limit < 1 ||
    value.limit > 100 ||
    (value.after !== undefined &&
      !opaqueIdSchema.safeParse(value.after).success)
  )
    throw new PersistenceError("invalid_page");
}
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
/** One shared validation layer around scoped host storage and one physical transaction. */
export function deploymentTransaction(
  base: FoundationTransaction,
  store: DeploymentRecordStore,
  guard: TransactionGuard,
): DeploymentTransaction {
  function scoped(value: { workspaceId: string }): void {
    if (value.workspaceId !== base.workspaceId)
      throw new PersistenceError("scope_violation");
  }
  async function recorded(at: string): Promise<void> {
    const value = Date.parse(utcTimestampSchema.parse(at));
    const latest = Date.parse(
      utcTimestampSchema.parse(await store.currentTime()),
    );
    if (value < Date.parse(base.now) || value > latest)
      throw new DeploymentPersistenceError("invalid_timestamp");
  }
  async function target(id: string): Promise<DeploymentTarget> {
    const value = deploymentTargetSchema.parse(
      required(await store.getTarget(opaqueIdSchema.parse(id))),
    );
    scoped(value);
    return value;
  }
  async function policy(value: DeploymentTarget, enabled = false) {
    const result = configuredPolicySchema.parse(
      required(await store.getPolicy(value.policyId)),
    );
    if (
      result.workspaceId !== base.workspaceId ||
      result.serviceId !== value.serviceId
    )
      throw new PersistenceError("scope_violation");
    if (enabled && !result.enabled) throw new PersistenceError("not_found");
    return policyDefinition(result);
  }
  function entry(
    value: DeploymentEntry,
    owner: DeploymentTarget,
  ): DeploymentEntry {
    const parsed = deploymentEntrySchema.parse(value);
    scoped(parsed.deployment);
    if (
      parsed.targetId !== owner.id ||
      parsed.deployment.serviceId !== owner.serviceId ||
      parsed.deployment.environmentId !== owner.environmentId
    )
      throw new PersistenceError("scope_violation");
    return parsed;
  }
  async function token(owner: DeploymentTarget, id: string) {
    const value = deploymentTokenSchema.parse(
      required(await store.getToken(opaqueIdSchema.parse(id))),
    );
    scoped(value);
    if (value.targetId !== owner.id)
      throw new PersistenceError("scope_violation");
    return value;
  }
  return {
    ...base,
    currentTime: () => guard.operation(() => store.currentTime()),
    targets: {
      routing: (id) =>
        guard.operation(async () => policy(await target(id), true)),
      get: (id) =>
        guard.operation(async () => {
          const result = await store.getTarget(opaqueIdSchema.parse(id));
          if (!result) return undefined;
          const value = deploymentTargetSchema.parse(result);
          scoped(value);
          return value;
        }),
      list: (input) =>
        guard.operation(async () => {
          page(input);
          const result = await store.listTargets(input);
          for (const row of result.items)
            scoped(deploymentTargetSchema.parse(row));
          return result;
        }),
      insert: (input) =>
        guard.operation(async () => {
          const value = deploymentTargetSchema.parse(input);
          scoped(value);
          if (value.revision !== 1)
            throw new DeploymentPersistenceError("invalid_version");
          if (value.createdAt !== value.updatedAt)
            throw new DeploymentPersistenceError("invalid_timestamp");
          await recorded(value.createdAt);
          required(await base.services.get(value.serviceId));
          required(await base.environments.get(value.environmentId));
          await policy(value);
          await store.insertTarget(value);
        }),
      replace: (input, expected) =>
        guard.operation(async () => {
          const value = deploymentTargetSchema.parse(input);
          scoped(value);
          if (
            !Number.isSafeInteger(expected) ||
            expected < 1 ||
            value.revision !== expected + 1
          )
            throw new DeploymentPersistenceError("invalid_version");
          const previous = await target(value.id);
          if (previous.revision !== expected) return false;
          for (const key of [
            "serviceId",
            "environmentId",
            "createdAt",
          ] as const)
            if (value[key] !== previous[key])
              throw new DeploymentPersistenceError("identity_change");
          if (Date.parse(value.updatedAt) < Date.parse(previous.updatedAt))
            throw new DeploymentPersistenceError("invalid_timestamp");
          await recorded(value.updatedAt);
          await policy(value);
          return store.replaceTarget(value, expected);
        }),
    },
    tokens: {
      get: (targetId, hash) =>
        guard.operation(async () => {
          const owner = await target(targetId);
          deploymentTokenSchema.shape.tokenHash.parse(hash);
          const found = await store.getTokenByHash(hash);
          if (!found || found.targetId !== owner.id) return undefined;
          const value = deploymentTokenSchema.parse(found);
          scoped(value);
          return value;
        }),
      list: (targetId, input) =>
        guard.operation(async () => {
          const owner = await target(targetId);
          page(input);
          const result = await store.listTokens(owner.id, input);
          for (const row of result.items) {
            const value = deploymentTokenSchema.parse(row);
            scoped(value);
            if (value.targetId !== owner.id)
              throw new PersistenceError("scope_violation");
          }
          return result;
        }),
      insert: (input) =>
        guard.operation(async () => {
          const value = deploymentTokenSchema.parse(input);
          scoped(value);
          await target(value.targetId);
          if (value.revokedAt !== null)
            throw new DeploymentPersistenceError("invalid_timestamp");
          await recorded(value.createdAt);
          if (value.mappedDeployerId !== null) {
            const responder = required(
              await base.responders.get(value.mappedDeployerId),
            );
            if (!responder.enabled) throw new PersistenceError("not_found");
          }
          await store.insertToken(value);
        }),
      revoke: (targetId, id) =>
        guard.operation(async () => {
          const owner = await target(targetId);
          const value = await store.getToken(opaqueIdSchema.parse(id));
          if (!value || value.targetId !== owner.id) return false;
          scoped(deploymentTokenSchema.parse(value));
          if (value.revokedAt !== null) return true;
          const at = utcTimestampSchema.parse(await store.currentTime());
          if (Date.parse(at) < Date.parse(value.createdAt))
            throw new DeploymentPersistenceError("invalid_timestamp");
          return store.revokeToken(value.id, at);
        }),
    },
    deployments: {
      get: (targetId, id) =>
        guard.operation(async () => {
          const owner = await target(targetId);
          const value = await store.getDeployment(
            owner.id,
            opaqueIdSchema.parse(id),
          );
          return value ? entry(value, owner) : undefined;
        }),
      find: (targetId, source, externalId) =>
        guard.operation(async () => {
          const owner = await target(targetId);
          const value = await store.findDeployment(
            owner.id,
            deploymentSchema.shape.source.parse(source),
            deploymentSchema.shape.externalId.parse(externalId),
          );
          return value ? entry(value, owner) : undefined;
        }),
      list: (targetId, input) =>
        guard.operation(async () => {
          const owner = await target(targetId);
          page(input);
          const result = await store.listDeployments(owner.id, input);
          return {
            ...result,
            items: result.items.map((value) => entry(value, owner)),
          };
        }),
      insert: (input) =>
        guard.operation(async () => {
          const owner = await target(input.targetId);
          const value = entry(input, owner);
          const currentPolicy = await policy(owner, true);
          if (!same(value.policy, currentPolicy))
            throw new DeploymentPersistenceError("identity_change");
          const deployment = value.deployment;
          const grant = await token(owner, deployment.tokenId);
          await recorded(deployment.acceptedAt);
          const expected = startDeployment(
            undefined,
            {
              version: 1,
              source: deployment.source,
              externalId: deployment.externalId,
              environmentId: owner.environmentId,
              actor: deployment.actor,
              commit: deployment.commit,
              artifact: deployment.artifact,
              occurredAt: deployment.startedAt,
              ...(deployment.coverageDecisionId === undefined
                ? {}
                : { coverageDecisionId: deployment.coverageDecisionId }),
            },
            {
              id: deployment.id,
              workspaceId: base.workspaceId,
              serviceId: owner.serviceId,
              environmentId: owner.environmentId,
              tokenId: grant.id,
              mappedDeployerId: grant.mappedDeployerId,
              timeoutSeconds: owner.timeoutSeconds,
            },
            deployment.acceptedAt,
          );
          if (
            expected.state !== "changed" ||
            !same(expected.deployment, deployment)
          )
            throw new DeploymentPersistenceError("invalid_transition");
          await store.insertDeployment(value);
        }),
      replace: (targetId, input, expectedRevision) =>
        guard.operation(async () => {
          const owner = await target(targetId);
          const value = deploymentSchema.parse(input);
          scoped(value);
          if (
            !Number.isSafeInteger(expectedRevision) ||
            expectedRevision < 1 ||
            value.revision !== expectedRevision + 1
          )
            throw new DeploymentPersistenceError("invalid_version");
          const previous = entry(
            required(await store.getDeployment(owner.id, value.id)),
            owner,
          ).deployment;
          if (previous.revision !== expectedRevision) return false;
          await recorded(value.updatedAt);
          const decision =
            value.finish && !previous.finish
              ? finishDeployment(
                  previous,
                  {
                    version: 1,
                    source: value.source,
                    externalId: value.externalId,
                    environmentId: value.environmentId,
                    actor: value.finish.actor,
                    outcome: value.finish.outcome,
                    occurredAt: value.finish.occurredAt,
                  },
                  value.updatedAt,
                )
              : timeoutDeployment(previous, value.updatedAt);
          if (decision.state !== "changed" || !same(decision.deployment, value))
            throw new DeploymentPersistenceError("invalid_transition");
          return store.replaceDeployment(owner.id, value, expectedRevision);
        }),
    },
    receipts: {
      get: (targetId, key) =>
        guard.operation(async () => {
          const owner = await target(targetId);
          const value = await store.getReceipt(
            owner.id,
            deploymentIdempotencyKeySchema.parse(key),
          );
          if (!value) return undefined;
          const parsed = deploymentReceiptSchema.parse(value);
          scoped(parsed);
          if (parsed.targetId !== owner.id)
            throw new PersistenceError("scope_violation");
          return parsed;
        }),
      insert: (input) =>
        guard.operation(async () => {
          const value = deploymentReceiptSchema.parse(input);
          scoped(value);
          const owner = await target(value.targetId);
          await token(owner, value.tokenId);
          await recorded(value.recordedAt);
          if (value.result.state !== "rejected") {
            const stored = entry(
              required(
                await store.getDeployment(owner.id, value.result.deploymentId),
              ),
              owner,
            ).deployment;
            if (
              stored.revision !== value.result.revision ||
              stored.status !== value.result.status ||
              stored.coverageDecisionId !== value.result.coverageDecisionId
            )
              throw new DeploymentPersistenceError("invalid_receipt");
          }
          await store.insertReceipt(value);
        }),
    },
  };
}
