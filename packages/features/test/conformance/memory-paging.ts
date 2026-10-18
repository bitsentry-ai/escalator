import {
  validatePageReplacement,
  validateAttemptCompletion,
} from "../../src/application/paging/validation.js";
import { z } from "zod";
import {
  acknowledgementGrantSchema,
  deliveryAttemptSchema,
  operationalIncidentSchema,
  operationalPageSchema,
  pageStepSchema,
  recipientDeliverySchema,
  type WorkspaceId,
  type Clock,
} from "../../src/contracts/index.js";
import {
  PersistenceError,
  type EntityRepository,
} from "../../src/application/ports/persistence.js";
import type {
  PagingRepository,
  PagingTransaction,
} from "../../src/application/paging/persistence.js";
import { MemoryFoundationRepository } from "./memory.js";

/** Reference test adapter. All paging and foundation effects use the same cloned transaction. */
export class MemoryPagingRepository implements PagingRepository {
  readonly foundation: MemoryFoundationRepository;
  constructor(clock: Clock) {
    this.foundation = new MemoryFoundationRepository(clock);
  }
  transaction<T>(
    workspaceId: WorkspaceId,
    work: (tx: PagingTransaction) => Promise<T>,
  ): Promise<T> {
    return this.foundation.withExtensions(
      workspaceId,
      async (base, extensions, guard) => {
        const locked = new Set<string>();
        const dataSchema = z.strictObject({
          incidents: z.array(operationalIncidentSchema),
          pages: z.array(operationalPageSchema),
          steps: z.array(pageStepSchema),
          deliveries: z.array(recipientDeliverySchema),
          attempts: z.array(deliveryAttemptSchema),
          grants: z.array(acknowledgementGrantSchema),
        });
        const data = dataSchema.parse(
          extensions.paging ?? {
            incidents: [],
            pages: [],
            steps: [],
            deliveries: [],
            attempts: [],
            grants: [],
          },
        );
        extensions.paging = data;
        const scoped = <E extends { workspaceId: WorkspaceId }>(rows: E[]) =>
          rows.filter((row) => row.workspaceId === workspaceId);
        function repo<E extends { id: string; workspaceId: WorkspaceId }>(
          rows: E[],
          schema: z.ZodType<E>,
          key: (value: E) => string,
          references: (value: E) => Promise<void>,
        ): EntityRepository<E> {
          return {
            get: (id) =>
              guard.operation(() =>
                structuredClone(scoped(rows).find((row) => row.id === id)),
              ),
            list: (query) =>
              guard.operation(() => {
                if (
                  !Number.isInteger(query.limit) ||
                  query.limit < 1 ||
                  query.limit > 100
                )
                  throw new PersistenceError("invalid_page");
                const values = scoped(rows)
                  .filter((row) => !query.after || row.id > query.after)
                  .sort((a, b) => (a.id < b.id ? -1 : 1));
                const items = values.slice(0, query.limit);
                return structuredClone({
                  items,
                  next: values.length > query.limit ? items.at(-1)!.id : null,
                });
              }),
            insert: (input) =>
              guard.operation(async () => {
                const value = schema.parse(input);
                if (value.workspaceId !== workspaceId)
                  throw new PersistenceError("scope_violation");
                if (!(await base.workspace.get()))
                  throw new PersistenceError("not_found");
                if (
                  scoped(rows).some(
                    (row) => row.id === value.id || key(row) === key(value),
                  )
                )
                  throw new PersistenceError("already_exists");
                await references(value);
                rows.push(structuredClone(value));
              }),
          };
        }
        function requireValue<T>(value: T | undefined): T {
          if (value === undefined) throw new PersistenceError("not_found");
          return value;
        }
        const incidents = repo(
          data.incidents,
          operationalIncidentSchema,
          (value) => value.id,
          async (value) => {
            requireValue(await base.services.get(value.serviceId));
            requireValue(await base.environments.get(value.environmentId));
          },
        );
        const pages = repo(
          data.pages,
          operationalPageSchema,
          (value) => value.id,
          async (value) => {
            const incident = requireValue(
              await incidents.get(value.incidentId),
            );
            if (incident.serviceId !== value.policy.serviceId)
              throw new PersistenceError("scope_violation");
            if (value.revision !== 1 || value.state !== "open")
              throw new Error("Page must start open at revision one");
          },
        );
        const steps = repo(
          data.steps,
          pageStepSchema,
          (value) => JSON.stringify([value.pageId, value.logicalStepId]),
          async (value) => {
            requireValue(await pages.get(value.pageId));
            for (const recipient of value.recipientIds)
              requireValue(await base.responders.get(recipient));
          },
        );
        const deliveries = repo(
          data.deliveries,
          recipientDeliverySchema,
          (value) =>
            JSON.stringify([value.pageId, value.stepId, value.recipientId]),
          async (value) => {
            const step = requireValue(await steps.get(value.stepId));
            if (
              step.pageId !== value.pageId ||
              !step.recipientIds.includes(value.recipientId)
            )
              throw new PersistenceError("scope_violation");
          },
        );
        const attempts = repo(
          data.attempts,
          deliveryAttemptSchema,
          (value) => JSON.stringify([value.deliveryId, value.attempt]),
          async (value) => {
            requireValue(await deliveries.get(value.deliveryId));
            if (value.outcome !== "in_flight")
              throw new Error("Attempt must start in flight");
          },
        );
        const grants = repo(
          data.grants,
          acknowledgementGrantSchema,
          (value) => value.tokenDigest,
          async (value) => {
            const attempt = requireValue(await attempts.get(value.attemptId));
            const delivery = requireValue(
              await deliveries.get(attempt.deliveryId),
            );
            if (
              delivery.pageId !== value.pageId ||
              delivery.recipientId !== value.recipientId
            )
              throw new PersistenceError("scope_violation");
          },
        );
        return work({
          ...base,
          incidents,
          steps,
          deliveries,
          pages: {
            ...pages,
            lock: (id) =>
              guard.operation(async () => {
                const page = await pages.get(id);
                if (page) locked.add(id);
                return page;
              }),
            replace: (input, expectedRevision) =>
              guard.operation(async () => {
                const value = operationalPageSchema.parse(input);
                if (value.workspaceId !== workspaceId)
                  throw new PersistenceError("scope_violation");
                if (!locked.has(value.id))
                  throw new Error("Page lock required");
                const index = data.pages.findIndex(
                  (row) =>
                    row.workspaceId === workspaceId && row.id === value.id,
                );
                const previous = data.pages[index];
                if (!previous || previous.revision !== expectedRevision)
                  return false;
                validatePageReplacement(previous, value);
                if (value.acknowledgedBy)
                  requireValue(await base.responders.get(value.acknowledgedBy));
                data.pages[index] = structuredClone(value);
                return true;
              }),
          },
          attempts: {
            ...attempts,
            finish: (input) =>
              guard.operation(() => {
                const value = deliveryAttemptSchema.parse(input);
                if (value.workspaceId !== workspaceId)
                  throw new PersistenceError("scope_violation");
                const index = data.attempts.findIndex(
                  (row) =>
                    row.workspaceId === workspaceId && row.id === value.id,
                );
                const previous = data.attempts[index];
                if (
                  !previous ||
                  previous.claimToken !== value.claimToken ||
                  previous.outcome !== "in_flight"
                )
                  return false;
                validateAttemptCompletion(previous, value);
                data.attempts[index] = structuredClone(value);
                return true;
              }),
          },
          grants: {
            ...grants,
            findValid: (tokenDigest) =>
              guard.operation(() => {
                acknowledgementGrantSchema.shape.tokenDigest.parse(tokenDigest);
                return structuredClone(
                  scoped(data.grants).find(
                    (row) =>
                      row.tokenDigest === tokenDigest &&
                      Date.parse(row.expiresAt) > Date.parse(base.now),
                  ),
                );
              }),
          },
        });
      },
    );
  }
}
