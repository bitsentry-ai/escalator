import type {
  AcknowledgementGrant,
  DeliveryAttempt,
  OperationalIncident,
  OperationalPage,
  PageStep,
  RecipientDelivery,
} from "../../contracts/index.js";
import type { Page, PageRequest } from "../ports/persistence.js";

/** Implemented inside the host's already-scoped physical transaction. */
export interface PagingRecordMap {
  incidents: OperationalIncident;
  pages: OperationalPage;
  steps: PageStep;
  deliveries: RecipientDelivery;
  attempts: DeliveryAttempt;
  grants: AcknowledgementGrant;
}
export type PagingRecordKind = keyof PagingRecordMap;
export interface PagingRecordStore {
  get<K extends PagingRecordKind>(
    kind: K,
    id: string,
    lock?: boolean,
  ): Promise<PagingRecordMap[K] | undefined>;
  list<K extends PagingRecordKind>(
    kind: K,
    query: PageRequest,
    parentId?: string,
  ): Promise<Page<PagingRecordMap[K]>>;
  insert<K extends PagingRecordKind>(
    kind: K,
    value: PagingRecordMap[K],
  ): Promise<void>;
  /** Caller holds the row lock; this primitive does not decide lifecycle changes. */
  replace<K extends "pages" | "attempts">(
    kind: K,
    value: PagingRecordMap[K],
  ): Promise<void>;
  findGrant(tokenDigest: string): Promise<AcknowledgementGrant | undefined>;
}
