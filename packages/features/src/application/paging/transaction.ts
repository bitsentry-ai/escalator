import { z } from "zod";
import {
  acknowledgementGrantSchema,
  deliveryAttemptSchema,
  operationalIncidentSchema,
  operationalPageSchema,
  pageStepSchema,
  recipientDeliverySchema,
} from "../../contracts/index.js";
import {
  PersistenceError,
  type EntityRepository,
  type FoundationTransaction,
} from "../ports/persistence.js";
import type { TransactionGuard } from "../ports/transaction-guard.js";
import type { PagingTransaction } from "./persistence.js";
import type {
  PagingRecordKind,
  PagingRecordMap,
  PagingRecordStore,
} from "./record-store.js";
import {
  validatePageReplacement,
  validateAttemptCompletion,
} from "./validation.js";

/** Both host adapters use these invariants with their scoped transactional storage. */
export function pagingTransaction(
  base: FoundationTransaction,
  store: PagingRecordStore,
  guard: TransactionGuard,
): PagingTransaction {
  const locked = new Set<string>();
  const scope = base.workspaceId;
  function requireValue<T>(value: T | undefined): T {
    if (value === undefined) throw new PersistenceError("not_found");
    return value;
  }
  function repository<K extends PagingRecordKind>(
    kind: K,
    schema: z.ZodType<PagingRecordMap[K]>,
    references: (value: PagingRecordMap[K]) => Promise<void>,
  ): EntityRepository<PagingRecordMap[K]> {
    return {
      get: (id) => guard.operation(() => store.get(kind, id)),
      list: (query) =>
        guard.operation(() => {
          if (
            !Number.isInteger(query.limit) ||
            query.limit < 1 ||
            query.limit > 100 ||
            (query.after !== undefined &&
              (typeof query.after !== "string" || query.after.length > 200))
          )
            throw new PersistenceError("invalid_page");
          return store.list(kind, query);
        }),
      insert: (input) =>
        guard.operation(async () => {
          const value = schema.parse(input);
          if (value.workspaceId !== scope)
            throw new PersistenceError("scope_violation");
          requireValue(await base.workspace.get());
          await references(value);
          await store.insert(kind, value);
        }),
    };
  }
  const incidents = repository(
    "incidents",
    operationalIncidentSchema,
    async (value) => {
      requireValue(await base.services.get(value.serviceId));
      requireValue(await base.environments.get(value.environmentId));
    },
  );
  const pages = repository("pages", operationalPageSchema, async (value) => {
    const incident = requireValue(await incidents.get(value.incidentId));
    if (incident.serviceId !== value.policy.serviceId)
      throw new PersistenceError("scope_violation");
    if (value.revision !== 1 || value.state !== "open")
      throw new Error("Page must start open at revision one");
  });
  const steps = repository("steps", pageStepSchema, async (value) => {
    requireValue(await pages.get(value.pageId));
    for (const recipient of value.recipientIds)
      requireValue(await base.responders.get(recipient));
  });
  const deliveries = repository(
    "deliveries",
    recipientDeliverySchema,
    async (value) => {
      const step = requireValue(await steps.get(value.stepId));
      if (
        step.pageId !== value.pageId ||
        !step.recipientIds.includes(value.recipientId)
      )
        throw new PersistenceError("scope_violation");
    },
  );
  const attempts = repository(
    "attempts",
    deliveryAttemptSchema,
    async (value) => {
      requireValue(await deliveries.get(value.deliveryId));
      if (value.outcome !== "in_flight")
        throw new Error("Attempt must start in flight");
    },
  );
  const grants = repository(
    "grants",
    acknowledgementGrantSchema,
    async (value) => {
      const attempt = requireValue(await attempts.get(value.attemptId));
      const delivery = requireValue(await deliveries.get(attempt.deliveryId));
      if (
        delivery.pageId !== value.pageId ||
        delivery.recipientId !== value.recipientId
      )
        throw new PersistenceError("scope_violation");
    },
  );
  return {
    ...base,
    incidents,
    steps,
    deliveries,
    pages: {
      ...pages,
      lock: (id) =>
        guard.operation(async () => {
          const page = await store.get("pages", id, true);
          if (page) locked.add(id);
          return page;
        }),
      replace: (input, expectedRevision) =>
        guard.operation(async () => {
          const value = operationalPageSchema.parse(input);
          if (value.workspaceId !== scope)
            throw new PersistenceError("scope_violation");
          if (!locked.has(value.id)) throw new Error("Page lock required");
          const previous = await store.get("pages", value.id);
          if (!previous || previous.revision !== expectedRevision) return false;
          validatePageReplacement(previous, value);
          if (value.acknowledgedBy)
            requireValue(await base.responders.get(value.acknowledgedBy));
          await store.replace("pages", value);
          return true;
        }),
    },
    attempts: {
      ...attempts,
      finish: (input) =>
        guard.operation(async () => {
          const value = deliveryAttemptSchema.parse(input);
          if (value.workspaceId !== scope)
            throw new PersistenceError("scope_violation");
          const previous = await store.get("attempts", value.id, true);
          if (
            !previous ||
            previous.claimToken !== value.claimToken ||
            previous.outcome !== "in_flight"
          )
            return false;
          validateAttemptCompletion(previous, value);
          await store.replace("attempts", value);
          return true;
        }),
    },
    grants: {
      ...grants,
      findValid: (tokenDigest) =>
        guard.operation(() => {
          acknowledgementGrantSchema.shape.tokenDigest.parse(tokenDigest);
          return store.findGrant(tokenDigest);
        }),
    },
  };
}
