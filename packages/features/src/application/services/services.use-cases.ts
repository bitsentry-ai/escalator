import {
  createServiceSchema,
  listServicesSchema,
  serviceSchema,
  serviceIdSchema,
  hasCapability,
  type Actor,
  type CreateServiceInput,
  type ListServicesInput,
  type ServicePage,
} from "../../contracts/index.js";
import type { FoundationRepository } from "../ports/persistence.js";
export class ServiceError extends Error {
  constructor(readonly code: "forbidden" | "not_found") {
    super(code);
  }
}
/** Both hosts call these use cases with an actor built by their own trusted identity adapter. */
export class ServiceUseCases {
  constructor(
    private readonly repository: FoundationRepository,
    private readonly newId: () => string,
  ) {}
  async listServices(
    actor: Actor,
    input: ListServicesInput = {},
  ): Promise<ServicePage> {
    if (!hasCapability(actor.role, "service:read"))
      throw new ServiceError("forbidden");
    const page = listServicesSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, (tx) =>
      tx.services.list(page),
    );
  }
  async getService(actor: Actor, id: string) {
    if (!hasCapability(actor.role, "service:read"))
      throw new ServiceError("forbidden");
    const serviceId = serviceIdSchema.parse(id);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      const value = await tx.services.get(serviceId);
      if (!value) throw new ServiceError("not_found");
      return value;
    });
  }
  async createService(actor: Actor, input: CreateServiceInput) {
    if (!hasCapability(actor.role, "service:manage"))
      throw new ServiceError("forbidden");
    const fields = createServiceSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      if (!(await tx.workspace.get())) throw new ServiceError("not_found");
      const service = serviceSchema.parse({
        ...fields,
        id: this.newId(),
        workspaceId: actor.workspaceId,
        enabled: true,
        createdAt: tx.now,
        updatedAt: tx.now,
      });
      await tx.services.insert(service);
      await tx.audit.append({
        id: this.newId(),
        workspaceId: actor.workspaceId,
        actor: { kind: "responder", responderId: actor.responderId },
        action: "service.created",
        subjectType: "service",
        subjectId: service.id,
        recordedAt: tx.now,
        metadata: { key: service.key, owningTeam: service.owningTeam },
      });
      return service;
    });
  }
}
