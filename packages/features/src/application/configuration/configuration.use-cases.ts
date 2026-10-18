import { z } from "zod";
import {
  hasCapability,
  writeScheduleSchema,
  writeContactSchema,
  writePolicySchema,
  writeAvailabilitySchema,
  configurationPageSchema,
  configurationIdSchema,
  previewScheduleInputSchema,
  scheduleSchema,
  configuredContactSchema,
  configuredPolicySchema,
  availabilitySchema,
  schedulePreviewSchema,
  type Actor,
  type Capability,
  type ConfigurationPageInput,
  type WriteScheduleInput,
  type WriteContactInput,
  type WritePolicyInput,
  type WriteAvailabilityInput,
  type PreviewScheduleInput,
} from "../../contracts/index.js";
import { previewSchedule } from "../../domain/schedule/resolve.js";
import {
  type EntityRepository,
  type Page,
  PersistenceError,
} from "../ports/persistence.js";
import type {
  ConfigurationRepository,
  ConfigurationTransaction,
  ConfigurationKind,
  ConfigurationRecordMap,
} from "./ports.js";
export class ConfigurationAccessError extends Error {
  constructor(
    readonly code: "forbidden" | "conflict" | "invalid_configuration",
  ) {
    super(code);
  }
}
function parsePolicy(value: unknown) {
  try {
    return configuredPolicySchema.parse(value);
  } catch (error) {
    if (error instanceof z.ZodError)
      throw new ConfigurationAccessError("invalid_configuration");
    throw error;
  }
}
function records<K extends ConfigurationKind>(
  tx: ConfigurationTransaction,
  kind: K,
) {
  // The keyed port guarantees that each repository returns its corresponding record.
  const map: {
    [P in ConfigurationKind]: Pick<
      EntityRepository<ConfigurationRecordMap[P]>,
      "get" | "list"
    >;
  } = tx.configuration;
  return map[kind];
}
function authorize(actor: Actor, capability: Capability) {
  if (!hasCapability(actor.role, capability))
    throw new ConfigurationAccessError("forbidden");
}
/** Host identity supplies scope; all configuration writes and their audit share a transaction. */
export class ConfigurationUseCases {
  constructor(
    private readonly repository: ConfigurationRepository,
    private readonly newId: () => string,
  ) {}
  async list<K extends ConfigurationKind>(
    actor: Actor,
    kind: K,
    input: ConfigurationPageInput = {},
  ): Promise<Page<ConfigurationRecordMap[K]>> {
    authorize(actor, "schedule:read");
    const query = configurationPageSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, (tx) =>
      records(tx, kind).list(query),
    );
  }
  async get<K extends ConfigurationKind>(
    actor: Actor,
    kind: K,
    input: { id: string },
  ): Promise<ConfigurationRecordMap[K]> {
    authorize(actor, "schedule:read");
    const { id } = configurationIdSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      const value = await records(tx, kind).get(
        id as ConfigurationRecordMap[K]["id"],
      );
      if (!value) throw new PersistenceError("not_found");
      return value;
    });
  }
  async responders(actor: Actor, input: ConfigurationPageInput = {}) {
    authorize(actor, "schedule:read");
    const query = configurationPageSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, (tx) =>
      tx.responders.list(query),
    );
  }
  private async mutate<T>(
    actor: Actor,
    run: (tx: ConfigurationTransaction) => Promise<T>,
  ) {
    authorize(actor, "schedule:manage");
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      if (!(await tx.responders.get(actor.responderId))?.enabled)
        throw new ConfigurationAccessError("forbidden");
      return run(tx);
    });
  }
  private audit(
    tx: ConfigurationTransaction,
    actor: Actor,
    kind: string,
    id: string,
    version: number,
  ) {
    return tx.audit.append({
      id: this.newId(),
      workspaceId: actor.workspaceId,
      actor: { kind: "responder", responderId: actor.responderId },
      action: `${kind}.configured`,
      subjectType: kind,
      subjectId: id,
      recordedAt: tx.now,
      metadata: { version },
    });
  }
  async writeSchedule(actor: Actor, input: WriteScheduleInput) {
    const { expectedVersion, ...fields } = writeScheduleSchema.parse(input);
    return this.mutate(actor, async (tx) => {
      const value = scheduleSchema.parse({
        ...fields,
        workspaceId: actor.workspaceId,
        version: (expectedVersion ?? 0) + 1,
      });
      if (!(await tx.configuration.schedules.put(value, expectedVersion)))
        throw new ConfigurationAccessError("conflict");
      await this.audit(tx, actor, "schedule", value.id, value.version);
      return value;
    });
  }
  async writeContact(actor: Actor, input: WriteContactInput) {
    const { expectedVersion, ...fields } = writeContactSchema.parse(input);
    return this.mutate(actor, async (tx) => {
      const value = configuredContactSchema.parse({
        ...fields,
        workspaceId: actor.workspaceId,
        version: (expectedVersion ?? 0) + 1,
      });
      if (!(await tx.configuration.contacts.put(value, expectedVersion)))
        throw new ConfigurationAccessError("conflict");
      await this.audit(tx, actor, "contact", value.id, value.version);
      return value;
    });
  }
  async writePolicy(actor: Actor, input: WritePolicyInput) {
    const { expectedVersion, ...fields } = writePolicySchema.parse(input);
    return this.mutate(actor, async (tx) => {
      const value = parsePolicy({
        ...fields,
        workspaceId: actor.workspaceId,
        version: (expectedVersion ?? 0) + 1,
      });
      if (!(await tx.configuration.policies.put(value, expectedVersion)))
        throw new ConfigurationAccessError("conflict");
      await this.audit(tx, actor, "policy", value.id, value.version);
      return value;
    });
  }
  async writeAvailability(actor: Actor, input: WriteAvailabilityInput) {
    const { expectedVersion, ...fields } = writeAvailabilitySchema.parse(input);
    return this.mutate(actor, async (tx) => {
      const value = availabilitySchema.parse({
        ...fields,
        workspaceId: actor.workspaceId,
        version: (expectedVersion ?? 0) + 1,
      });
      if (!(await tx.configuration.availability.put(value, expectedVersion)))
        throw new ConfigurationAccessError("conflict");
      await this.audit(tx, actor, "availability", value.id, value.version);
      return value;
    });
  }
  async coverage(actor: Actor, input: PreviewScheduleInput) {
    authorize(actor, "schedule:read");
    const fields = previewScheduleInputSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      const schedule = await tx.configuration.schedules.get(fields.scheduleId);
      if (!schedule) throw new PersistenceError("not_found");
      return {
        ...fields,
        scheduleVersion: schedule.version,
        intervals: previewSchedule(schedule, fields.startsAt, fields.endsAt),
      };
    });
  }
  async preview(actor: Actor, input: PreviewScheduleInput) {
    const fields = previewScheduleInputSchema.parse(input);
    return this.mutate(actor, async (tx) => {
      const schedule = await tx.configuration.schedules.get(fields.scheduleId);
      if (!schedule) throw new PersistenceError("not_found");
      const value = schedulePreviewSchema.parse({
        ...fields,
        id: this.newId(),
        workspaceId: actor.workspaceId,
        serviceId: schedule.serviceId,
        scheduleVersion: schedule.version,
        createdAt: tx.now,
        intervals: previewSchedule(schedule, fields.startsAt, fields.endsAt),
      });
      await tx.configuration.previews.insert(value);
      await this.audit(
        tx,
        actor,
        "schedule_preview",
        value.id,
        schedule.version,
      );
      return value;
    });
  }
}
