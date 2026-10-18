import {
  detectionBindingKeySchema,
  writeDetectionBindingSchema,
  hasCapability,
  type Actor,
  type DetectionBindingKey,
  type WriteDetectionBindingInput,
} from "../../contracts/index.js";
import { PersistenceError } from "../ports/persistence.js";
import type { DetectionRepository } from "./ports.js";
export class DetectionManagementError extends Error {
  constructor(
    readonly code: "forbidden" | "conflict" | "invalid_configuration",
  ) {
    super(code);
  }
}
/** Host identity supplies scope; automatic paging changes require configuration authority. */
export class DetectionManagement {
  constructor(
    private readonly repository: DetectionRepository,
    private readonly newId: () => string,
  ) {}
  get(actor: Actor, input: DetectionBindingKey) {
    if (!hasCapability(actor.role, "service:read"))
      throw new DetectionManagementError("forbidden");
    const value = detectionBindingKeySchema.parse(input);
    return this.repository.transaction(actor.workspaceId, (tx) =>
      tx.detection.binding(value.serviceId, value.environmentId),
    );
  }
  async configure(actor: Actor, input: WriteDetectionBindingInput) {
    if (
      !hasCapability(actor.role, "schedule:manage") ||
      !hasCapability(actor.role, "service:manage")
    )
      throw new DetectionManagementError("forbidden");
    const { expectedVersion, ...fields } =
      writeDetectionBindingSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      const current = await tx.detection.binding(
        fields.serviceId,
        fields.environmentId,
      );
      if ((current?.version ?? null) !== expectedVersion)
        throw new DetectionManagementError("conflict");
      const service = await tx.services.get(fields.serviceId);
      if (!service) throw new PersistenceError("not_found");
      if (fields.enabled && !service.enabled)
        throw new DetectionManagementError("invalid_configuration");
      if (fields.policyId) {
        const policy = await tx.configuration.policies.get(fields.policyId);
        if (!policy) throw new PersistenceError("not_found");
        if (
          policy.serviceId !== fields.serviceId ||
          (fields.enabled && !policy.enabled)
        )
          throw new DetectionManagementError("invalid_configuration");
      }
      const value = {
        ...fields,
        id: current?.id ?? this.newId(),
        workspaceId: actor.workspaceId,
        version: (expectedVersion ?? 0) + 1,
        createdAt: current?.createdAt ?? tx.now,
        updatedAt: tx.now,
      };
      if (!(await tx.detection.putBinding(value, expectedVersion)))
        throw new DetectionManagementError("conflict");
      await tx.audit.append({
        id: this.newId(),
        workspaceId: actor.workspaceId,
        actor: { kind: "responder", responderId: actor.responderId },
        action: "detection.binding.configured",
        subjectType: "service_environment",
        subjectId: value.id,
        recordedAt: tx.now,
        metadata: {
          enabled: value.enabled,
          policyId: value.policyId,
          version: value.version,
        },
      });
      return value;
    });
  }
}
