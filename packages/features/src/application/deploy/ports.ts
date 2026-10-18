import type {
  Deployment,
  DeploymentTarget,
  DeploymentToken,
  DeploymentEntry,
  DeploymentReceipt,
  WorkspaceId,
  ConfiguredPolicy,
  EscalationPolicy,
} from "../../contracts/index.js";
import type {
  FoundationTransaction,
  Page,
  PageRequest,
} from "../ports/persistence.js";
export interface DeploymentTransaction extends FoundationTransaction {
  currentTime(): Promise<string>;
  targets: {
    /** Locks this target before grant, deployment, receipt, work or audit writes.
     * A unique (workspace, service, environment) target serializes absent records too.
     */
    get(id: string): Promise<DeploymentTarget | undefined>;
    /** Active routing definition read within this same locked target transaction. */
    routing(id: string): Promise<EscalationPolicy>;
    list(page: PageRequest): Promise<Page<DeploymentTarget>>;
    insert(value: DeploymentTarget): Promise<void>;
    replace(
      value: DeploymentTarget,
      expectedRevision: number,
    ): Promise<boolean>;
  };
  tokens: {
    get(
      targetId: string,
      tokenHash: string,
    ): Promise<DeploymentToken | undefined>;
    list(targetId: string, page: PageRequest): Promise<Page<DeploymentToken>>;
    insert(value: DeploymentToken): Promise<void>;
    /** Immutable first revocation timestamp from live database time under target lock. */
    revoke(targetId: string, id: string): Promise<boolean>;
  };
  deployments: {
    get(targetId: string, id: string): Promise<DeploymentEntry | undefined>;
    find(
      targetId: string,
      source: string,
      externalId: string,
    ): Promise<DeploymentEntry | undefined>;
    list(targetId: string, page: PageRequest): Promise<Page<DeploymentEntry>>;
    /** Only a new STARTED revision, with the target's current scoped routing snapshot. */
    insert(entry: DeploymentEntry): Promise<void>;
    /** Routing and start identity are immutable; only a valid next lifecycle transition. */
    replace(
      targetId: string,
      value: Deployment,
      expectedRevision: number,
    ): Promise<boolean>;
  };
  receipts: {
    get(targetId: string, key: string): Promise<DeploymentReceipt | undefined>;
    /** Unique (workspace,target,key); conflicting content never overwrites a result. */
    insert(value: DeploymentReceipt): Promise<void>;
  };
}
export interface DeploymentRepository {
  /** Authentication projection only; transaction must recheck grant/target/expiry. */
  findTokenContext(
    hash: string,
  ): Promise<
    Pick<DeploymentToken, "workspaceId" | "targetId" | "id"> | undefined
  >;
  /** Same atomic, scoped, poisoned-lifetime contract as FoundationRepository. No I/O. */
  transaction<T>(
    workspaceId: WorkspaceId,
    run: (tx: DeploymentTransaction) => Promise<T>,
  ): Promise<T>;
}
/** Scoped host primitives on one physical transaction. Target reads lock rows;
 * deployment natural keys and token hashes have database uniqueness constraints.
 * Lists are bounded and scoped. Closed handles cannot be reused.
 */
export interface DeploymentRecordStore {
  currentTime(): Promise<string>;
  getPolicy(id: string): Promise<ConfiguredPolicy | undefined>;
  getTarget(id: string): Promise<DeploymentTarget | undefined>;
  listTargets(page: PageRequest): Promise<Page<DeploymentTarget>>;
  insertTarget(value: DeploymentTarget): Promise<void>;
  replaceTarget(
    value: DeploymentTarget,
    expectedRevision: number,
  ): Promise<boolean>;
  getTokenByHash(hash: string): Promise<DeploymentToken | undefined>;
  getToken(id: string): Promise<DeploymentToken | undefined>;
  listTokens(
    targetId: string,
    page: PageRequest,
  ): Promise<Page<DeploymentToken>>;
  insertToken(value: DeploymentToken): Promise<void>;
  revokeToken(id: string, at: string): Promise<boolean>;
  getDeployment(
    targetId: string,
    id: string,
  ): Promise<DeploymentEntry | undefined>;
  findDeployment(
    targetId: string,
    source: string,
    externalId: string,
  ): Promise<DeploymentEntry | undefined>;
  listDeployments(
    targetId: string,
    page: PageRequest,
  ): Promise<Page<DeploymentEntry>>;
  insertDeployment(value: DeploymentEntry): Promise<void>;
  replaceDeployment(
    targetId: string,
    value: Deployment,
    expectedRevision: number,
  ): Promise<boolean>;
  getReceipt(
    targetId: string,
    key: string,
  ): Promise<DeploymentReceipt | undefined>;
  insertReceipt(value: DeploymentReceipt): Promise<void>;
}
