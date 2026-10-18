import type {
  DeploymentCoverageDecision,
  DeploymentTarget,
  WorkspaceId,
  ResponderId,
} from "../../contracts/index.js";
import type { DeploymentCoverageSnapshot } from "../../domain/deploy/coverage.js";
import type { DeploymentRepository, DeploymentTransaction } from "./ports.js";
/** Coverage commands use a separate idempotency namespace from lifecycle writes. */
export interface CoverageRecord {
  decision: DeploymentCoverageDecision;
  key: string;
  requestHash: string;
}
export interface CoveragePersistence {
  /** One coherent bounded snapshot; overflow is explicit. No network I/O. */
  snapshot(
    targetId: string,
    mappedDeployerId: ResponderId | null,
  ): Promise<DeploymentCoverageSnapshot>;
  get(targetId: string, id: string): Promise<CoverageRecord | undefined>;
  find(targetId: string, key: string): Promise<CoverageRecord | undefined>;
  /** Append-only; same transaction as the actor's audit event. */
  insert(value: CoverageRecord): Promise<void>;
}
export interface CoverageTransaction extends DeploymentTransaction {
  coverage: CoveragePersistence;
}
export interface CoverageRepository extends DeploymentRepository {
  transaction<T>(
    scope: WorkspaceId,
    run: (tx: CoverageTransaction) => Promise<T>,
  ): Promise<T>;
}
/** Host primitives share the original deployment transaction and its guard. */
export interface CoverageRecordStore {
  snapshot(
    target: DeploymentTarget,
    mappedDeployerId: ResponderId | null,
  ): Promise<DeploymentCoverageSnapshot>;
  get(targetId: string, id: string): Promise<CoverageRecord | undefined>;
  find(targetId: string, key: string): Promise<CoverageRecord | undefined>;
  insert(value: CoverageRecord): Promise<void>;
}
