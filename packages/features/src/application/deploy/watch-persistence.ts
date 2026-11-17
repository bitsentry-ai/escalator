import {
  deploymentWatchRecordSchema,
  watchCriteriaSchema,
  opaqueIdSchema,
  utcTimestampSchema,
  type DeploymentBaseline,
  type DeploymentEntry,
  type DeploymentWatchRecord,
  type OperationalIncident,
  type WorkspaceId,
} from "../../contracts/index.js";
import { PersistenceError } from "../ports/persistence.js";
import type { TransactionGuard } from "../ports/transaction-guard.js";
import type { BaselineTransaction } from "./baseline.js";
import {
  advanceDeploymentWatch,
  linkWatchIncident,
  startDeploymentWatch,
  type WatchEvaluationUpdate,
} from "./watch-record.js";

/** All primitives share the deployment transaction and its locked target. Insert
 * must pin the captured sources for the watch window in that same transaction.
 * No provider calls, secret resolution or independently committed writes.
 */
export interface DeploymentWatchStore {
  get(
    targetId: string,
    deploymentId: string,
  ): Promise<DeploymentWatchRecord | undefined>;
  insert(
    value: DeploymentWatchRecord,
    baseline: DeploymentBaseline | undefined,
  ): Promise<void>;
  replace(
    value: DeploymentWatchRecord,
    expectedRevision: number,
  ): Promise<boolean>;
  incident(id: string): Promise<OperationalIncident | undefined>;
}
export interface DeploymentWatchTransaction extends BaselineTransaction {
  watches: {
    get(
      targetId: string,
      deploymentId: string,
    ): Promise<DeploymentWatchRecord | undefined>;
    /** Idempotent under target lock; only a recorded finish can initialize a watch. */
    initialize(
      targetId: string,
      deploymentId: string,
    ): Promise<DeploymentWatchRecord>;
    /** A failed verdict cannot commit before its scoped incident exists. The caller
     * must lock/create the owning page before acquiring any durable-work fence.
     */
    advance(
      targetId: string,
      deploymentId: string,
      expectedRevision: number,
      update: WatchEvaluationUpdate,
      incidentId?: string,
    ): Promise<DeploymentWatchRecord | undefined>;
  };
}
export interface DeploymentWatchRepository {
  transaction<T>(
    scope: WorkspaceId,
    run: (tx: DeploymentWatchTransaction) => Promise<T>,
  ): Promise<T>;
}
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
/** A watch accounts for exactly the baseline's captured streams, with unchanged sources and criteria. */
function assertUpdateMatchesBaseline(
  update: WatchEvaluationUpdate,
  baseline: DeploymentBaseline | undefined,
): void {
  if (!baseline) {
    if (update.streams.length !== 0 || update.inventoryComplete)
      throw new RangeError("Missing baseline cannot produce watch evidence");
    return;
  }
  if (!baseline.inventoryComplete && update.inventoryComplete)
    throw new RangeError("Incomplete baseline inventory");
  if (update.streams.length !== baseline.streams.length)
    throw new RangeError("Watch must account for every captured stream");
  for (const stream of update.streams) {
    const captured = baseline.streams.find(
      (row) => row.kind === stream.kind && row.id === stream.id,
    );
    if (
      !captured ||
      captured.sourceId !== stream.sourceId ||
      !same(
        captured.criteria,
        watchCriteriaSchema.parse(stream.evaluation.criteria),
      )
    )
      throw new PersistenceError("scope_violation");
  }
}
export function withDeploymentWatches<Tx extends BaselineTransaction>(
  base: Tx,
  store: DeploymentWatchStore,
  guard: TransactionGuard,
): Tx & DeploymentWatchTransaction {
  async function entry(
    targetId: string,
    deploymentId: string,
  ): Promise<DeploymentEntry> {
    opaqueIdSchema.parse(targetId);
    opaqueIdSchema.parse(deploymentId);
    const target = await base.targets.get(targetId);
    if (!target) throw new PersistenceError("not_found");
    const value = await base.deployments.get(targetId, deploymentId);
    if (!value) throw new PersistenceError("not_found");
    if (
      value.deployment.workspaceId !== base.workspaceId ||
      value.targetId !== targetId ||
      value.deployment.id !== deploymentId ||
      value.deployment.serviceId !== target.serviceId ||
      value.deployment.environmentId !== target.environmentId
    )
      throw new PersistenceError("scope_violation");
    return value;
  }
  function bound(
    raw: DeploymentWatchRecord,
    owner: DeploymentEntry,
  ): DeploymentWatchRecord {
    const value = deploymentWatchRecordSchema.parse(raw),
      initial = startDeploymentWatch(owner);
    for (const key of [
      "workspaceId",
      "targetId",
      "deploymentId",
      "serviceId",
      "environmentId",
      "startedAt",
      "endsAt",
    ] as const)
      if (value[key] !== initial[key])
        throw new PersistenceError("scope_violation");
    if (value.verdict === "FAIL" && value.incidentId === null)
      throw new Error("Persisted failed watch is missing its atomic incident");
    return value;
  }
  async function validateIncident(value: DeploymentWatchRecord): Promise<void> {
    if (value.incidentId === null) return;
    const incident = await store.incident(value.incidentId);
    if (
      !incident ||
      incident.id !== value.incidentId ||
      incident.workspaceId !== value.workspaceId ||
      incident.serviceId !== value.serviceId ||
      incident.environmentId !== value.environmentId
    )
      throw new PersistenceError("scope_violation");
  }
  return {
    ...base,
    watches: {
      get: (targetId, deploymentId) =>
        guard.operation(async () => {
          const owner = await entry(targetId, deploymentId);
          const raw = await store.get(targetId, deploymentId);
          if (raw === undefined) return undefined;
          const value = bound(raw, owner);
          await validateIncident(value);
          return value;
        }),
      initialize: (targetId, deploymentId) =>
        guard.operation(async () => {
          const owner = await entry(targetId, deploymentId);
          const raw = await store.get(targetId, deploymentId);
          if (raw !== undefined) {
            const value = bound(raw, owner);
            await validateIncident(value);
            return value;
          }
          const value = startDeploymentWatch(owner);
          const now = utcTimestampSchema.parse(await base.currentTime());
          if (Date.parse(value.startedAt) > Date.parse(now))
            throw new RangeError("Future watch start");
          const baseline = await base.baselines.get(targetId, deploymentId);
          await store.insert(value, baseline);
          return value;
        }),
      advance: (targetId, deploymentId, expectedRevision, update, incidentId) =>
        guard.operation(async () => {
          if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
            throw new RangeError("Invalid watch revision");
          const owner = await entry(targetId, deploymentId);
          const raw = await store.get(targetId, deploymentId);
          if (!raw) throw new PersistenceError("not_found");
          const current = bound(raw, owner);
          if (current.revision !== expectedRevision) return undefined;
          if (current.finalizedAt !== null) {
            await validateIncident(current);
            return current;
          }
          const at = Date.parse(utcTimestampSchema.parse(update.evaluatedAt));
          if (
            at < Date.parse(base.now) ||
            at > Date.parse(utcTimestampSchema.parse(await base.currentTime()))
          )
            throw new RangeError(
              "Watch evaluation must use this transaction's clock",
            );
          const baseline = await base.baselines.get(targetId, deploymentId);
          assertUpdateMatchesBaseline(update, baseline);
          let value = advanceDeploymentWatch(current, update);
          if (incidentId !== undefined)
            value = linkWatchIncident(value, incidentId);
          if (value.verdict === "FAIL" && value.incidentId === null)
            throw new Error("Failed watch requires an atomic incident link");
          await validateIncident(value);
          if (!(await store.replace(value, expectedRevision)))
            throw new Error("Locked watch changed");
          return value;
        }),
    },
  };
}
