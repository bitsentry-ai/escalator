import type {
  AcknowledgementGrant,
  DeliveryAttempt,
  OperationalIncident,
  OperationalPage,
  PageStep,
  RecipientDelivery,
  WorkspaceId,
} from "../../contracts/index.js";
import type {
  EntityRepository,
  FoundationTransaction,
} from "../ports/persistence.js";

export interface PagingTransaction extends FoundationTransaction {
  incidents: EntityRepository<OperationalIncident>;
  pages: EntityRepository<OperationalPage> & {
    /** Lock until transaction end; missing and foreign workspace IDs are indistinguishable. */
    lock(id: string): Promise<OperationalPage | undefined>;
    /** Requires the page lock. Only lifecycle fields/revision may change; snapshot is immutable. */
    replace(value: OperationalPage, expectedRevision: number): Promise<boolean>;
  };
  /** Unique (workspace, page, logicalStepId); insert never overwrites a resolution. */
  steps: EntityRepository<PageStep>;
  /** Unique (workspace, page, step, recipient); all references are scope checked. */
  deliveries: EntityRepository<RecipientDelivery>;
  attempts: EntityRepository<DeliveryAttempt> & {
    /** First result for this attempt wins. Acknowledging a page does not discard an in-flight result.
     * The claim token must match the persisted attempt, not a caller's current outbox lease.
     * A later attempt has a different ID, so a late result cannot overwrite it.
     */
    finish(value: DeliveryAttempt): Promise<boolean>;
  };
  grants: EntityRepository<AcknowledgementGrant> & {
    /** Lookup takes a SHA-256 digest only and rejects expiry using database time. */
    findValid(tokenDigest: string): Promise<AcknowledgementGrant | undefined>;
  };
}
export interface PagingRepository {
  /** Same rollback, poison-on-error and lifetime contract as FoundationRepository.
   * Foundation writes, paging writes, audit and outbox intents share one DB transaction.
   * Lock the page before making decisions that compete with acknowledgement.
   */
  transaction<T>(
    workspaceId: WorkspaceId,
    work: (tx: PagingTransaction) => Promise<T>,
  ): Promise<T>;
}
