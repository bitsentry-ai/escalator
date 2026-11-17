import type { OperationalIncident } from "../../src/contracts/index.js";
import type { FoundationTransaction } from "../../src/application/ports/persistence.js";
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
import {
  compareIncidentOrder,
  incidentCursor,
  incidentOrderKey,
  parseIncidentCursor,
} from "../../src/application/paging/incident-order.js";
import type { Page } from "../../src/application/ports/persistence.js";
import { MemoryFoundationRepository } from "./memory.js";

import type { TransactionGuard } from "../../src/application/ports/transaction-guard.js";
/** The delivery or page a child record belongs to. */
function parentOf(row: object): unknown {
  if ("deliveryId" in row) return row.deliveryId;
  if ("pageId" in row) return row.pageId;
  return undefined;
}

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
  constructor(
    private readonly clock: Clock,
    private readonly investigation?: (
      incident: OperationalIncident,
      tx: FoundationTransaction,
    ) => Promise<void>,
  ) {
    this.foundation = new MemoryFoundationRepository(clock);
  }
  transaction<T>(
    scope: WorkspaceId,
    work: (tx: PagingTransaction) => Promise<T>,
  ): Promise<T> {
    return this.withExtensions(scope, (tx) => work(tx));
  }
  withExtensions<T>(
    scope: WorkspaceId,
    work: (
      tx: PagingTransaction,
      extensions: Record<string, unknown>,
      guard: TransactionGuard,
    ) => Promise<T>,
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
          ...(this.investigation
            ? {
                enqueueInvestigation: (incident: OperationalIncident) =>
                  this.investigation!(incident, base),
              }
            : {}),
          async get(kind, id) {
            return structuredClone(rows(kind).find((row) => row.id === id));
          },
          async list(kind, query, parentId) {
            if (kind === "incidents") {
              const after =
                query.after === undefined
                  ? undefined
                  : parseIncidentCursor(query.after);
              const incidents = rows("incidents")
                .filter(
                  (row) =>
                    !after ||
                    compareIncidentOrder(incidentOrderKey(row), after) > 0,
                )
                .sort((a, b) =>
                  compareIncidentOrder(
                    incidentOrderKey(a),
                    incidentOrderKey(b),
                  ),
                );
              return structuredClone({
                items: incidents.slice(0, query.limit),
                next:
                  incidents.length > query.limit
                    ? incidentCursor(incidents[query.limit - 1])
                    : null,
              }) as Page<PagingRecordMap[typeof kind]>;
            }
            const values = rows(kind)
              .filter(
                (row) => parentId === undefined || parentOf(row) === parentId,
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
        return work(pagingTransaction(base, store, guard), extensions, guard);
      },
    );
  }
}
