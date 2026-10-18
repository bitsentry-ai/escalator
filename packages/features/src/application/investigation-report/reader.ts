import {
  hasCapability,
  incidentDetailInputSchema,
  investigationScopeSchema,
  type Actor,
  type InvestigationScope,
  type InvestigationView,
  type InvestigationExecutionAvailability,
} from "../../contracts/index.js";
import { projectInvestigationView } from "./project.js";
export interface InvestigationReportRepository {
  /** One tenant-scoped database snapshot. Join the requested incident to an enabled
   * responder in this workspace before selecting any investigation or evidence.
   * Return approved columns only, never job payloads or complete profile configuration. */
  read(
    actor: Pick<Actor, "workspaceId" | "responderId">,
    incidentId: string,
  ): Promise<
    | {
        scope: InvestigationScope;
        observedAt: string;
        row: unknown | null;
      }
    | undefined
  >;
}
export class InvestigationReportError extends Error {
  constructor(readonly code: "forbidden" | "not_found" | "invalid_snapshot") {
    super(code);
  }
}
export class InvestigationReports {
  constructor(
    private readonly repository: InvestigationReportRepository,
    private readonly execution: (
      scope: InvestigationScope,
    ) => InvestigationExecutionAvailability,
  ) {}
  async read(actor: Actor, input: { id: string }): Promise<InvestigationView> {
    if (!hasCapability(actor.role, "incident:read"))
      throw new InvestigationReportError("forbidden");
    const { id } = incidentDetailInputSchema.parse(input);
    const snapshot = await this.repository.read(
      { workspaceId: actor.workspaceId, responderId: actor.responderId },
      id,
    );
    if (!snapshot) throw new InvestigationReportError("not_found");
    try {
      const scope = investigationScopeSchema.parse(snapshot.scope);
      if (scope.workspaceId !== actor.workspaceId || scope.incidentId !== id)
        throw new InvestigationReportError("invalid_snapshot");
      return projectInvestigationView(
        scope,
        this.execution(scope),
        snapshot.observedAt,
        snapshot.row,
      );
    } catch {
      throw new InvestigationReportError("invalid_snapshot");
    }
  }
}
