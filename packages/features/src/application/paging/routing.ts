import type {
  Schedule,
  ScheduleId,
  ResponderId,
  WorkspaceId,
  PagingContact,
} from "../../contracts/index.js";
import type { PagingTransaction } from "./persistence.js";

export interface PagingRoutingReader {
  /** Reads join the same scoped transaction, never a second pool connection. */
  schedule(id: ScheduleId): Promise<Schedule | undefined>;
  contacts(responderId: ResponderId): Promise<PagingContact[]>;
}
export interface DispatchTransaction extends PagingTransaction {
  routing: PagingRoutingReader;
}
export interface DispatchRepository {
  transaction<T>(
    scope: WorkspaceId,
    work: (tx: DispatchTransaction) => Promise<T>,
  ): Promise<T>;
}
