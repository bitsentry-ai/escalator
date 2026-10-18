import { MemoryFoundationRepository } from "../conformance/memory.js";
import { investigationSettingsTransaction } from "../../src/application/investigation-settings/transaction.js";
import { InvestigationSettingsUseCases } from "../../src/application/investigation-settings/management.js";
import type {
  InvestigationSettingsRepository,
  InvestigationSettingsStore,
} from "../../src/application/investigation-settings/ports.js";
import {
  workspaceIdSchema,
  serviceIdSchema,
  environmentIdSchema,
  responderIdSchema,
  type Actor,
} from "../../src/contracts/identity.js";
import type {
  InvestigationSettings,
  CreateInvestigationSettingsInput,
} from "../../src/contracts/investigation-settings.js";
import { investigationFixture } from "./investigation.js";
export async function settingsFixture() {
  const now = "2026-10-05T00:00:00.000Z";
  const foundation = new MemoryFoundationRepository({
    now: () => new Date(now),
  });
  const scope = {
    workspaceId: workspaceIdSchema.parse("workspace_a"),
    serviceId: serviceIdSchema.parse("service_a"),
    environmentId: environmentIdSchema.parse("environment_a"),
  };
  await foundation.transaction(scope.workspaceId, async (tx) => {
    await tx.workspace.insert({
      id: scope.workspaceId,
      name: "Fixture",
      createdAt: now,
      updatedAt: now,
    });
    await tx.services.insert({
      id: scope.serviceId,
      workspaceId: scope.workspaceId,
      name: "API",
      key: "api",
      owningTeam: "Platform",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    await tx.environments.insert({
      id: scope.environmentId,
      workspaceId: scope.workspaceId,
      name: "Production",
      key: "production",
      isProduction: true,
      createdAt: now,
      updatedAt: now,
    });
  });
  const policy = {
    sources: true,
    secret: true,
    failAudit: false,
    sourceChecks: 0,
    secretChecks: 0,
  };
  const repository: InvestigationSettingsRepository = {
    transaction: (workspace, work) =>
      foundation.withExtensions(workspace, async (base, extensions, guard) => {
        const rows = (extensions.investigationSettings ??=
          []) as InvestigationSettings[];
        const local = () =>
          rows.filter((v) => v.profile.scope.workspaceId === workspace);
        const store: InvestigationSettingsStore = {
          lockScope: async (s) =>
            Boolean(await base.services.get(s.serviceId)) &&
            Boolean(await base.environments.get(s.environmentId)),
          get: async (id) =>
            structuredClone(local().find((v) => v.profile.id === id)),
          selected: async (s) =>
            structuredClone(
              local().find(
                (v) =>
                  v.profile.scope.serviceId === s.serviceId &&
                  v.profile.scope.environmentId === s.environmentId,
              ),
            ),
          authorizeSources: async () => {
            policy.sourceChecks++;
            return policy.sources;
          },
          authorizeSecret: async () => {
            policy.secretChecks++;
            return policy.secret;
          },
          put: async (value, expected) => {
            const current = local().find(
              (v) => v.profile.id === value.profile.id,
            );
            if ((current?.profile.revision ?? null) !== expected) return false;
            if (current) rows[rows.indexOf(current)] = structuredClone(value);
            else rows.push(structuredClone(value));
            return true;
          },
        };
        const tx = investigationSettingsTransaction(base, store, guard);
        if (policy.failAudit)
          tx.audit = {
            ...base.audit,
            append: async () => {
              throw new Error("Audit unavailable");
            },
          };
        return work(tx);
      }),
  };
  const actor: Actor = {
    workspaceId: scope.workspaceId,
    responderId: responderIdSchema.parse("owner"),
    role: "administrator",
  };
  let next = 0;
  const useCases = new InvestigationSettingsUseCases(
    repository,
    () => `settings_${++next}`,
  );
  const input: CreateInvestigationSettingsInput = {
    serviceId: scope.serviceId,
    environmentId: scope.environmentId,
    enabled: false,
    destination: {
      provider: "ollama",
      model: "local",
      location: "local",
      origin: "http://127.0.0.1:11434",
    },
    endpoint: "http://127.0.0.1:11434",
    secretId: null,
    limits: investigationFixture().claim.limits,
    sources: [
      { kind: "log", sourceId: "source_a", lookbackMs: 60000, limit: 10 },
    ],
  };
  const update = (value: InvestigationSettings) => ({
    id: value.profile.id,
    expectedRevision: value.profile.revision,
    enabled: value.enabled,
    destination: value.profile.destination,
    endpoint: value.profile.endpoint,
    secretId: value.profile.secretId,
    limits: value.limits,
    sources: value.sources,
  });
  return {
    now,
    scope,
    foundation,
    policy,
    repository,
    actor,
    useCases,
    input,
    update,
  };
}
