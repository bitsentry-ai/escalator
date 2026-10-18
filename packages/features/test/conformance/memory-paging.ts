import type { Clock, WorkspaceId } from "../../src/contracts/index.js";
import { PersistenceError } from "../../src/application/ports/persistence.js";
import type {
  PagingRepository,
  PagingTransaction,
} from "../../src/application/paging/persistence.js";
import type {
  PagingRecordKind,
  PagingRecordMap,
  PagingRecordStore,
} from "../../src/application/paging/record-store.js";
import { pagingTransaction } from "../../src/application/paging/transaction.js";
import { MemoryFoundationRepository } from "./memory.js";

type Stored = PagingRecordMap[PagingRecordKind];
type Rows = Record<PagingRecordKind, Stored[]>;
function naturalKey(kind: PagingRecordKind, value: Stored): string {
  switch (kind) {
    case "steps": {
      const row = value as PagingRecordMap["steps"];
      return JSON.stringify([row.pageId, row.logicalStepId]);
    }
    case "deliveries": {
      const row = value as PagingRecordMap["deliveries"];
      return JSON.stringify([row.pageId, row.stepId, row.recipientId]);
    }
    case "attempts": {
      const row = value as PagingRecordMap["attempts"];
      return JSON.stringify([row.deliveryId, row.attempt]);
    }
    case "grants":
      return (value as PagingRecordMap["grants"]).tokenDigest;
    default:
      return value.id;
  }
}
/** Serialized transactional storage; the same application invariants serve all adapters. */
export class MemoryPagingRepository implements PagingRepository {
  readonly foundation: MemoryFoundationRepository;
  constructor(private readonly clock: Clock) {
    this.foundation = new MemoryFoundationRepository(clock);
  }
  transaction<T>(
    scope: WorkspaceId,
    work: (tx: PagingTransaction) => Promise<T>,
  ): Promise<T> {
    return this.foundation.withExtensions(
      scope,
      async (base, extensions, guard) => {
        const data = (extensions.paging ?? {
          incidents: [],
          pages: [],
          steps: [],
          deliveries: [],
          attempts: [],
          grants: [],
        }) as Rows;
        extensions.paging = data;
        const rows = <K extends PagingRecordKind>(kind: K) =>
          data[kind].filter(
            (row) => row.workspaceId === scope,
          ) as PagingRecordMap[K][];
        const now = () => this.clock.now().getTime();
        const store: PagingRecordStore = {
          async get(kind, id) {
            return structuredClone(rows(kind).find((row) => row.id === id));
          },
          async list(kind, query, parentId) {
            const values = rows(kind)
              .filter(
                (row) =>
                  parentId === undefined ||
                  ("deliveryId" in row
                    ? row.deliveryId
                    : "pageId" in row
                      ? row.pageId
                      : undefined) === parentId,
              )
              .filter((row) => !query.after || row.id > query.after)
              .sort((a, b) => (a.id < b.id ? -1 : 1));
            return structuredClone({
              items: values.slice(0, query.limit),
              next:
                values.length > query.limit ? values[query.limit - 1].id : null,
            });
          },
          async insert(kind, value) {
            if (
              rows(kind).some(
                (row) =>
                  row.id === value.id ||
                  naturalKey(kind, row) === naturalKey(kind, value),
              )
            )
              throw new PersistenceError("already_exists");
            data[kind].push(structuredClone(value));
          },
          async replace(kind, value) {
            const index = data[kind].findIndex(
              (row) => row.workspaceId === scope && row.id === value.id,
            );
            if (index < 0) throw new PersistenceError("not_found");
            data[kind][index] = structuredClone(value);
          },
          async findGrant(digest) {
            return structuredClone(
              rows("grants").find(
                (row) =>
                  row.tokenDigest === digest &&
                  Date.parse(row.expiresAt) > now(),
              ),
            );
          },
        };
        return work(pagingTransaction(base, store, guard));
      },
    );
  }
}
