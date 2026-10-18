import { z } from "zod";
import {
  availabilitySchema,
  configuredContactSchema,
  pagingContactSchema,
  configuredPolicySchema,
  scheduleSchema,
  schedulePreviewSchema,
  opaqueIdSchema,
  type ConfiguredPolicy,
} from "../../contracts/index.js";
import {
  previewSchedule,
  validateSchedule,
} from "../../domain/schedule/resolve.js";
import { PersistenceError, type PageRequest } from "../ports/persistence.js";
import type { TransactionGuard } from "../ports/transaction-guard.js";
import type { PagingTransaction } from "../paging/persistence.js";
import type {
  ConfigurationRecordMap,
  ConfigurationRecordStore,
  ConfigurationTransaction,
  MutableConfigurationKind,
  VersionedRepository,
} from "./ports.js";

export class ConfigurationError extends Error {
  constructor(
    readonly code:
      | "invalid_version"
      | "stale_preview"
      | "invalid_preview"
      | "identity_change",
  ) {
    super(code);
  }
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new PersistenceError("not_found");
  return value;
}
function query(value: PageRequest): void {
  if (
    !Number.isInteger(value.limit) ||
    value.limit < 1 ||
    value.limit > 100 ||
    (value.after !== undefined &&
      (typeof value.after !== "string" || value.after.length > 200))
  )
    throw new PersistenceError("invalid_page");
}
/** Shared validation; host primitives must use the same scoped physical transaction. */
export function configurationTransaction(
  base: PagingTransaction,
  store: ConfigurationRecordStore,
  guard: TransactionGuard,
): ConfigurationTransaction {
  const scope = base.workspaceId;
  async function responders(ids: string[]) {
    for (const id of new Set(ids))
      required(
        await base.responders.get(
          id as Parameters<typeof base.responders.get>[0],
        ),
      );
  }
  async function policyReferences(value: ConfiguredPolicy) {
    // Stable lock ordering for a policy referencing the same schedules in reverse.
    const schedules = new Map<string, ConfigurationRecordMap["schedules"]>();
    for (const id of [
      ...new Set([value.primaryScheduleId, value.peerScheduleId]),
    ].sort()) {
      const schedule = required(await store.get("schedules", id, true));
      if (schedule.serviceId !== value.serviceId)
        throw new PersistenceError("scope_violation");
      schedules.set(id, schedule);
    }
    await responders([
      ...value.fallbackResponderIds,
      ...value.terminal.notifyResponderIds,
    ]);
    for (const [scheduleId, previewId] of [
      [value.primaryScheduleId, value.primaryPreviewId],
      [value.peerScheduleId, value.peerPreviewId],
    ] as const) {
      if (previewId === null) continue;
      const preview = required(await store.get("previews", previewId));
      const schedule = schedules.get(scheduleId)!;
      if (
        preview.scheduleId !== scheduleId ||
        preview.serviceId !== value.serviceId
      )
        throw new PersistenceError("scope_violation");
      if (
        value.enabled &&
        (!schedule.enabled || preview.scheduleVersion !== schedule.version)
      )
        throw new ConfigurationError("stale_preview");
    }
  }
  function repository<K extends MutableConfigurationKind>(
    kind: K,
    schema: z.ZodType<ConfigurationRecordMap[K]>,
    references: (value: ConfigurationRecordMap[K]) => Promise<void>,
  ): VersionedRepository<ConfigurationRecordMap[K]> {
    return {
      get: (id) =>
        guard.operation(() => {
          opaqueIdSchema.parse(id);
          return store.get(kind, id);
        }),
      list: (input) =>
        guard.operation(() => {
          query(input);
          return store.list(kind, input);
        }),
      put: (input, expected) =>
        guard.operation(async () => {
          const value = schema.parse(input);
          if (value.workspaceId !== scope)
            throw new PersistenceError("scope_violation");
          if (
            (expected !== null &&
              (!Number.isSafeInteger(expected) || expected < 1)) ||
            value.version !== (expected ?? 0) + 1
          )
            throw new ConfigurationError("invalid_version");
          required(await base.workspace.get());
          const previous = await store.get(kind, value.id, true);
          if (
            expected === null
              ? previous !== undefined
              : previous?.version !== expected
          )
            return false;
          if (
            previous &&
            (("serviceId" in previous &&
              "serviceId" in value &&
              previous.serviceId !== value.serviceId) ||
              ("responderId" in previous &&
                "responderId" in value &&
                previous.responderId !== value.responderId))
          )
            throw new ConfigurationError("identity_change");
          await references(value);
          if (previous) await store.replace(kind, value);
          else await store.insert(kind, value);
          return true;
        }),
    };
  }
  const schedules = repository("schedules", scheduleSchema, async (value) => {
    validateSchedule(value);
    required(await base.services.get(value.serviceId));
    await responders([
      ...value.rotations.flatMap((r) => r.responders),
      ...value.overrides.map((o) => o.responderId),
    ]);
  });
  const policies = repository(
    "policies",
    configuredPolicySchema,
    async (value) => {
      required(await base.services.get(value.serviceId));
      await policyReferences(value);
    },
  );
  const contacts = repository(
    "contacts",
    configuredContactSchema,
    async (value) => {
      await responders([value.responderId]);
      if (!(await store.secretExists(value.secretId)))
        throw new PersistenceError("not_found");
    },
  );
  const availability = repository(
    "availability",
    availabilitySchema,
    async (value) => {
      await responders([value.id]);
    },
  );
  const previews: ConfigurationTransaction["configuration"]["previews"] = {
    get: (id) =>
      guard.operation(() => {
        opaqueIdSchema.parse(id);
        return store.get("previews", id);
      }),
    list: (input) =>
      guard.operation(() => {
        query(input);
        return store.list("previews", input);
      }),
    forSchedule: (id, input) =>
      guard.operation(() => {
        opaqueIdSchema.parse(id);
        query(input);
        return store.list("previews", input, id);
      }),
    insert: (input) =>
      guard.operation(async () => {
        const value = schedulePreviewSchema.parse(input);
        if (value.workspaceId !== scope)
          throw new PersistenceError("scope_violation");
        const schedule = required(
          await store.get("schedules", value.scheduleId, true),
        );
        if (schedule.serviceId !== value.serviceId)
          throw new PersistenceError("scope_violation");
        if (schedule.version !== value.scheduleVersion)
          throw new ConfigurationError("stale_preview");
        const expected = previewSchedule(
          schedule,
          value.startsAt,
          value.endsAt,
        );
        if (
          Date.parse(value.createdAt) !== Date.parse(base.now) ||
          JSON.stringify(value.intervals) !== JSON.stringify(expected)
        )
          throw new ConfigurationError("invalid_preview");
        await store.insert("previews", value);
      }),
  };
  return {
    ...base,
    configuration: { schedules, policies, contacts, availability, previews },
    routing: {
      schedule: (id) => schedules.get(id),
      contacts: (id) =>
        guard.operation(async () => {
          opaqueIdSchema.parse(id);
          // Fail closed rather than silently truncate an excessive routing configuration.
          const page = await store.list("contacts", { limit: 100 }, id);
          if (page.next !== null) throw new Error("Too many paging contacts");
          return page.items.map((contact) =>
            pagingContactSchema.strip().parse(contact),
          );
        }),
    },
  };
}
