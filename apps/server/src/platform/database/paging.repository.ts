import type { Pool } from "pg";
import type { WorkspaceId } from "@bitsentry-escalator/features/contracts";
import {
  pagingTransaction,
  type PagingRepository,
  type PagingTransaction,
} from "@bitsentry-escalator/features/application";
import { PostgresFoundationRepository } from "./foundation.repository.js";
import { postgresPagingStore } from "./postgres-paging.store.js";

export class PostgresPagingRepository implements PagingRepository {
  private readonly foundation: PostgresFoundationRepository;
  constructor(pool: Pool) {
    this.foundation = new PostgresFoundationRepository(pool);
  }
  transaction<T>(
    scope: WorkspaceId,
    work: (tx: PagingTransaction) => Promise<T>,
  ): Promise<T> {
    return this.foundation.withConnection(scope, (base, connection, guard) =>
      work(
        pagingTransaction(base, postgresPagingStore(connection, scope), guard),
      ),
    );
  }
}
