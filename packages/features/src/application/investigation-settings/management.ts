import {
  createInvestigationSettingsSchema,
  updateInvestigationSettingsSchema,
  investigationSettingsSchema,
  type InvestigationSettings,
  type CreateInvestigationSettingsInput,
  type UpdateInvestigationSettingsInput,
} from "../../contracts/investigation-settings.js";
import {
  hasCapability,
  serviceIdSchema,
  environmentIdSchema,
  type Actor,
} from "../../contracts/identity.js";
import type {
  InvestigationSettingsRepository,
  InvestigationSettingsTransaction,
  InvestigationSettingsScope,
} from "./ports.js";
import { InvestigationSettingsError } from "./transaction.js";
export class InvestigationSettingsUseCases {
  constructor(
    private readonly repository: InvestigationSettingsRepository,
    private readonly newId: () => string,
  ) {}
  async get(
    actor: Actor,
    scope: Omit<InvestigationSettingsScope, "workspaceId">,
  ) {
    if (!hasCapability(actor.role, "service:read"))
      throw new InvestigationSettingsError("forbidden");
    const selected = {
      workspaceId: actor.workspaceId,
      serviceId: serviceIdSchema.parse(scope.serviceId),
      environmentId: environmentIdSchema.parse(scope.environmentId),
    };
    return this.repository.transaction(actor.workspaceId, (tx) =>
      tx.investigationSettings.selected(selected),
    );
  }
  async create(actor: Actor, input: CreateInvestigationSettingsInput) {
    if (!hasCapability(actor.role, "service:manage"))
      throw new InvestigationSettingsError("forbidden");
    const data = createInvestigationSettingsSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      const value = investigationSettingsSchema.parse({
        profile: {
          id: this.newId(),
          revision: 1,
          scope: {
            workspaceId: actor.workspaceId,
            serviceId: data.serviceId,
            environmentId: data.environmentId,
          },
          destination: data.destination,
          endpoint: data.endpoint,
          secretId: data.secretId,
        },
        enabled: data.enabled,
        limits: data.limits,
        sources: data.sources,
        createdAt: tx.now,
        updatedAt: tx.now,
      });
      await this.save(tx, actor, value, null);
      return value;
    });
  }
  async update(actor: Actor, input: UpdateInvestigationSettingsInput) {
    if (!hasCapability(actor.role, "service:manage"))
      throw new InvestigationSettingsError("forbidden");
    const data = updateInvestigationSettingsSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      const current = await tx.investigationSettings.get(data.id);
      if (!current) throw new InvestigationSettingsError("not_found");
      if (current.profile.revision !== data.expectedRevision)
        throw new InvestigationSettingsError("conflict");
      const value = investigationSettingsSchema.parse({
        ...current,
        profile: {
          ...current.profile,
          revision: data.expectedRevision + 1,
          destination: data.destination,
          endpoint: data.endpoint,
          secretId: data.secretId,
        },
        enabled: data.enabled,
        limits: data.limits,
        sources: data.sources,
        updatedAt: tx.now,
      });
      await this.save(tx, actor, value, data.expectedRevision);
      return value;
    });
  }
  private async save(
    tx: InvestigationSettingsTransaction,
    actor: Actor,
    value: InvestigationSettings,
    expected: number | null,
  ) {
    if (!(await tx.investigationSettings.save(actor, value, expected)))
      throw new InvestigationSettingsError("conflict");
    await tx.audit.append({
      id: this.newId(),
      workspaceId: actor.workspaceId,
      actor: { kind: "responder", responderId: actor.responderId },
      action:
        expected === null
          ? "investigation.settings_created"
          : "investigation.settings_updated",
      subjectType: "investigation_profile",
      subjectId: value.profile.id,
      recordedAt: tx.now,
      metadata: {
        revision: value.profile.revision,
        enabled: value.enabled,
        sourceCount: value.sources.length,
      },
    });
  }
}
