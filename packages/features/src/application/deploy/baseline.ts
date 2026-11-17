import {
  deploymentEntrySchema,
  opaqueIdSchema,
  deploymentBaselineSchema,
  deploymentBaselineSeconds,
  type DeploymentBaseline,
  type DeploymentEntry,
} from "../../contracts/index.js";
import { PersistenceError } from "../ports/persistence.js";
import type { TransactionGuard } from "../ports/transaction-guard.js";
import type { DeploymentTransaction } from "./ports.js";
import { periodicCoverage } from "../retention/coverage.js";

/** Host implementations use the same guarded physical deployment transaction.
 * Capture returns a coherent bounded snapshot with actual outcomes/counts. No network I/O.
 * Insert persists the immutable snapshot and its retention references atomically.
 */
export interface DeploymentBaselineStore {
  capture(entry: DeploymentEntry): Promise<DeploymentBaseline>;
  get(
    targetId: string,
    deploymentId: string,
  ): Promise<DeploymentBaseline | undefined>;
  insert(value: DeploymentBaseline): Promise<void>;
}
export interface BaselineTransaction extends DeploymentTransaction {
  baselines: {
    get(
      targetId: string,
      deploymentId: string,
    ): Promise<DeploymentBaseline | undefined>;
  };
}
/** A captured stream's evidence covers exactly the baseline window, with configuration known at capture. */
function assertBaselineStream(
  stream: DeploymentBaseline["streams"][number],
  workspaceId: string,
  start: number,
  captured: number,
): void {
  const evidence = stream.evidence;
  if (evidence.workspaceId !== workspaceId || evidence.streamId !== stream.id)
    throw new PersistenceError("scope_violation");
  if (
    Date.parse(evidence.startAt) !== start - deploymentBaselineSeconds * 1000 ||
    Date.parse(evidence.endAt) !== start ||
    Date.parse(evidence.visibleAt) !== captured
  )
    throw new RangeError("Baseline evidence window differs");
  for (const segment of evidence.segments)
    if (
      segment.version > stream.configurationVersion ||
      (segment.recordedAt !== null && Date.parse(segment.recordedAt) > captured)
    )
      throw new RangeError("Baseline contains unavailable configuration");
}
export function validateDeploymentBaseline(
  raw: unknown,
  rawEntry: DeploymentEntry,
): DeploymentBaseline {
  const value = deploymentBaselineSchema.parse(raw);
  const entry = deploymentEntrySchema.parse(rawEntry);
  const owner = entry.deployment;
  if (
    value.workspaceId !== owner.workspaceId ||
    value.targetId !== entry.targetId ||
    value.deploymentId !== owner.id ||
    value.serviceId !== owner.serviceId ||
    value.environmentId !== owner.environmentId
  )
    throw new PersistenceError("scope_violation");
  const start = Date.parse(owner.startedAt),
    captured = Date.parse(value.capturedAt);
  if (
    Date.parse(value.startedAt) !== start ||
    captured < Date.parse(owner.acceptedAt)
  )
    throw new RangeError("Invalid baseline capture chronology");
  for (const stream of value.streams) {
    const evidence = stream.evidence;
    assertBaselineStream(stream, owner.workspaceId, start, captured);
    periodicCoverage({
      workspaceId: evidence.workspaceId,
      streamId: evidence.streamId,
      startAt: evidence.startAt,
      endAt: evidence.endAt,
      visibleAt: evidence.visibleAt,
      complete: evidence.complete,
      segments: evidence.segments,
      samples: evidence.samples.map(
        ({ id, version, slotAt, observedAt, receivedAt, usable }) => ({
          id,
          version,
          slotAt,
          observedAt,
          receivedAt,
          usable,
        }),
      ),
    });
    for (const sample of evidence.samples)
      if (
        sample.version > stream.configurationVersion ||
        sample.reading.kind !== stream.kind ||
        Date.parse(sample.observedAt) > captured ||
        (sample.receivedAt !== null && Date.parse(sample.receivedAt) > captured)
      )
        throw new RangeError("Baseline contains unavailable evidence");
  }
  return value;
}
/** Decorate accepted starts, not HTTP callbacks: insert, evidence, pins and audit
 * remain one rollback unit, including when callers catch an operation failure.
 */
export function withDeploymentBaseline<Tx extends DeploymentTransaction>(
  base: Tx,
  store: DeploymentBaselineStore,
  guard: TransactionGuard,
): Tx & BaselineTransaction {
  return {
    ...base,
    deployments: {
      ...base.deployments,
      insert: (raw) =>
        guard.operation(async () => {
          const entry = deploymentEntrySchema.parse(raw);
          if (entry.deployment.workspaceId !== base.workspaceId)
            throw new PersistenceError("scope_violation");
          await base.deployments.insert(entry);
          const value = validateDeploymentBaseline(
            await store.capture(entry),
            entry,
          );
          if (
            Date.parse(value.capturedAt) > Date.parse(await base.currentTime())
          )
            throw new RangeError("Baseline capture is in the future");
          await store.insert(value);
        }),
    },
    baselines: {
      get: (targetId, deploymentId) =>
        guard.operation(async () => {
          opaqueIdSchema.parse(targetId);
          opaqueIdSchema.parse(deploymentId);
          const target = await base.targets.get(targetId);
          if (!target) throw new PersistenceError("not_found");
          const entry = await base.deployments.get(targetId, deploymentId);
          if (!entry) throw new PersistenceError("not_found");
          const value = await store.get(targetId, deploymentId);
          return value === undefined
            ? undefined
            : validateDeploymentBaseline(value, entry);
        }),
    },
  };
}
