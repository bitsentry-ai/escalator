import type { z } from "zod";
import { investigationSettingsSchema } from "../../contracts/investigation-settings.js";
import {
  hasCapability,
  opaqueIdSchema,
  serviceIdSchema,
  environmentIdSchema,
} from "../../contracts/identity.js";
import {
  PersistenceError,
  type FoundationTransaction,
} from "../ports/persistence.js";
import type { TransactionGuard } from "../ports/transaction-guard.js";
import type {
  InvestigationSettingsStore,
  InvestigationSettingsTransaction,
  InvestigationSettingsScope,
} from "./ports.js";
export class InvestigationSettingsError extends Error {
  constructor(
    readonly code:
      | "forbidden"
      | "not_found"
      | "conflict"
      | "invalid_revision"
      | "identity_change"
      | "invalid_timestamp",
  ) {
    super(code);
  }
}
/** One validation path for both SQL adapters. The guard poisons caught failed operations. */
type Settings = z.infer<typeof investigationSettingsSchema>;
function assertSaveRequest(
  actor: { workspaceId: string; role: Parameters<typeof hasCapability>[0] },
  value: Settings,
  expected: number | null,
  base: { workspaceId: string; now: string },
): void {
  if (actor.workspaceId !== base.workspaceId)
    throw new PersistenceError("scope_violation");
  if (!hasCapability(actor.role, "service:manage"))
    throw new InvestigationSettingsError("forbidden");
  if (
    (expected !== null && (!Number.isSafeInteger(expected) || expected < 1)) ||
    value.profile.revision !== (expected ?? 0) + 1
  )
    throw new InvestigationSettingsError("invalid_revision");
  if (
    value.updatedAt !== base.now ||
    (expected === null && value.createdAt !== base.now)
  )
    throw new InvestigationSettingsError("invalid_timestamp");
}
/** A saved profile keeps its service, environment and creation time. */
function assertSameIdentity(current: Settings, value: Settings): void {
  if (
    current.profile.scope.serviceId !== value.profile.scope.serviceId ||
    current.profile.scope.environmentId !== value.profile.scope.environmentId ||
    current.createdAt !== value.createdAt
  )
    throw new InvestigationSettingsError("identity_change");
}
/**
 * Disabling a profile must remain possible after a connection or secret has been revoked. Enabling or changing its
 * configuration always requires fresh metadata authorization.
 */
function onlyEnabledChanged(
  current: Settings | undefined,
  value: Settings,
): boolean {
  return (
    current !== undefined &&
    JSON.stringify({
      ...current,
      enabled: value.enabled,
      updatedAt: value.updatedAt,
      profile: { ...current.profile, revision: value.profile.revision },
    }) === JSON.stringify(value)
  );
}
export function investigationSettingsTransaction(
  base: FoundationTransaction,
  store: InvestigationSettingsStore,
  guard: TransactionGuard,
): InvestigationSettingsTransaction {
  const scoped = (scope: InvestigationSettingsScope) => {
    serviceIdSchema.parse(scope.serviceId);
    environmentIdSchema.parse(scope.environmentId);
    if (scope.workspaceId !== base.workspaceId)
      throw new PersistenceError("scope_violation");
  };
  return {
    ...base,
    investigationSettings: {
      get: (id) =>
        guard.operation(async () => {
          const value = await store.get(opaqueIdSchema.parse(id));
          if (value) scoped(value.profile.scope);
          return value;
        }),
      selected: (scope) =>
        guard.operation(async () => {
          scoped(scope);
          const value = await store.selected(scope);
          if (value) {
            scoped(value.profile.scope);
            if (
              value.profile.scope.serviceId !== scope.serviceId ||
              value.profile.scope.environmentId !== scope.environmentId
            )
              throw new PersistenceError("scope_violation");
          }
          return value;
        }),
      save: (actor, input, expected) =>
        guard.operation(async () => {
          const value = investigationSettingsSchema.parse(input);
          const profile = value.profile;
          scoped(profile.scope);
          assertSaveRequest(actor, value, expected, base);
          if (!(await store.lockScope(profile.scope)))
            throw new InvestigationSettingsError("not_found");
          const current = await store.get(profile.id);
          if ((current?.profile.revision ?? null) !== expected) return false;
          if (current) {
            scoped(current.profile.scope);
            assertSameIdentity(current, value);
          }
          const selected = await store.selected(profile.scope);
          if (selected && selected.profile.id !== profile.id) return false;
          if (value.enabled || !onlyEnabledChanged(current, value)) {
            if (
              !(await store.authorizeSources(
                actor,
                profile.scope,
                value.sources,
              )) ||
              (profile.secretId !== null &&
                !(await store.authorizeSecret(actor, profile)))
            )
              throw new InvestigationSettingsError("not_found");
          }
          if (
            value.enabled &&
            !(await base.services.get(profile.scope.serviceId))?.enabled
          )
            throw new InvestigationSettingsError("not_found");
          return store.put(value, expected);
        }),
    },
  };
}
