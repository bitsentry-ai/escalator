import {
  deploymentCoverageDecisionSchema,
  deploymentIdempotencyKeySchema,
  opaqueIdSchema,
  responderIdSchema,
  type ResponderId,
  hasCapability,
  type DeploymentTarget,
} from "../../contracts/index.js";
import {
  evaluateDeploymentCoverage,
  validateDeploymentCoverageSnapshot,
  type DeploymentCoverageSnapshot,
} from "../../domain/deploy/coverage.js";
import { PersistenceError } from "../ports/persistence.js";
import type { TransactionGuard } from "../ports/transaction-guard.js";
import type { DeploymentTransaction } from "./ports.js";
import type {
  CoverageRecord,
  CoverageRecordStore,
  CoverageTransaction,
} from "./coverage-ports.js";
export class CoveragePersistenceError extends Error {
  constructor(
    readonly code: "invalid_coverage" | "stale_coverage" | "forbidden",
  ) {
    super(code);
  }
}
/** One shared validation layer for both hosts; failed operations poison all writes. */
export function coverageTransaction(
  base: DeploymentTransaction,
  store: CoverageRecordStore,
  guard: TransactionGuard,
): CoverageTransaction {
  const snapshots = new Map<string, DeploymentCoverageSnapshot>();
  async function target(id: string) {
    const value = await base.targets.get(opaqueIdSchema.parse(id));
    if (!value) throw new PersistenceError("not_found");
    if (value.workspaceId !== base.workspaceId)
      throw new PersistenceError("scope_violation");
    return value;
  }
  function record(
    raw: CoverageRecord,
    owner: DeploymentTarget,
  ): CoverageRecord {
    const decision = deploymentCoverageDecisionSchema.parse(raw.decision);
    const binding = decision.binding;
    deploymentIdempotencyKeySchema.parse(raw.key);
    if (
      typeof raw.requestHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(raw.requestHash)
    )
      throw new CoveragePersistenceError("invalid_coverage");
    if (
      binding.workspaceId !== base.workspaceId ||
      binding.targetId !== owner.id ||
      binding.serviceId !== owner.serviceId ||
      binding.environmentId !== owner.environmentId
    )
      throw new PersistenceError("scope_violation");
    return { decision, key: raw.key, requestHash: raw.requestHash };
  }
  async function snapshot(id: string, mappedDeployerId: ResponderId | null) {
    mappedDeployerId = responderIdSchema.nullable().parse(mappedDeployerId);
    const cacheKey = JSON.stringify([id, mappedDeployerId]);
    const owner = await target(id);
    let value = snapshots.get(cacheKey);
    if (!value) {
      value = validateDeploymentCoverageSnapshot(
        await store.snapshot(owner, mappedDeployerId),
        {
          workspaceId: owner.workspaceId,
          targetId: owner.id,
          targetRevision: owner.revision,
          policyId: owner.policyId,
          serviceId: owner.serviceId,
          environmentId: owner.environmentId,
          source: "validation",
          externalId: "validation",
          mappedDeployerId,
        },
      );
      snapshots.set(cacheKey, structuredClone(value));
    }
    return structuredClone(value);
  }
  return {
    ...base,
    deployments: {
      ...base.deployments,
      insert: (input) =>
        guard.operation(async () => {
          const deployment = input.deployment;
          if (deployment.coverageDecisionId !== undefined) {
            const owner = await target(input.targetId);
            const raw = await store.get(
              owner.id,
              opaqueIdSchema.parse(deployment.coverageDecisionId),
            );
            if (!raw || raw.decision.id !== deployment.coverageDecisionId)
              throw new CoveragePersistenceError("invalid_coverage");
            const proof = record(raw, owner).decision;
            if (
              proof.binding.source !== deployment.source ||
              proof.binding.externalId !== deployment.externalId ||
              proof.binding.mappedDeployerId !== deployment.mappedDeployerId ||
              Date.parse(deployment.acceptedAt) <
                Date.parse(proof.evaluatedAt) ||
              Date.parse(deployment.acceptedAt) >= Date.parse(proof.expiresAt)
            )
              throw new CoveragePersistenceError("invalid_coverage");
          }
          await base.deployments.insert(input);
        }),
    },
    coverage: {
      snapshot: (id, mappedDeployerId) =>
        guard.operation(() => snapshot(id, mappedDeployerId)),
      get: (targetId, id) =>
        guard.operation(async () => {
          const owner = await target(targetId);
          const value = await store.get(targetId, opaqueIdSchema.parse(id));
          if (value && value.decision.id !== id)
            throw new CoveragePersistenceError("invalid_coverage");
          return value === undefined ? undefined : record(value, owner);
        }),
      find: (targetId, key) =>
        guard.operation(async () => {
          const owner = await target(targetId);
          const value = await store.find(
            targetId,
            deploymentIdempotencyKeySchema.parse(key),
          );
          if (value && value.key !== key)
            throw new CoveragePersistenceError("invalid_coverage");
          return value === undefined ? undefined : record(value, owner);
        }),
      insert: (raw) =>
        guard.operation(async () => {
          const owner = await target(raw.decision.binding.targetId);
          const value = record(raw, owner);
          const { decision } = value;
          const binding = decision.binding;
          if (
            binding.targetRevision !== owner.revision ||
            binding.policyId !== owner.policyId
          )
            throw new CoveragePersistenceError("stale_coverage");
          const at = Date.parse(decision.evaluatedAt),
            now = Date.parse(await base.currentTime());
          if (at < Date.parse(base.now) || at > now)
            throw new CoveragePersistenceError("invalid_coverage");
          const expected = evaluateDeploymentCoverage(
            await snapshot(owner.id, binding.mappedDeployerId),
            binding,
            decision.evaluatedAt,
          );
          const normalized =
            deploymentCoverageDecisionSchema.shape.evaluation.parse(expected);
          if (
            JSON.stringify(normalized) !== JSON.stringify(decision.evaluation)
          )
            throw new CoveragePersistenceError("invalid_coverage");
          if (decision.override) {
            const actor = await base.responders.get(
              decision.override.responderId,
            );
            if (
              !actor?.enabled ||
              !hasCapability(actor.role, "deployment:override")
            )
              throw new CoveragePersistenceError("forbidden");
          }
          await store.insert(value);
        }),
    },
  };
}
