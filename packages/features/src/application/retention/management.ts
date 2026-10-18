import {
  hasCapability,
  replayCoverageQuerySchema,
  updateReplayRetentionSchema,
  type Actor,
  type ReplayCoverageQuery,
  type UpdateReplayRetention,
} from "../../contracts/index.js";
import { MaintenanceAdmission } from "./runtime.js";
import {
  RetentionPolicyManagement,
  RetentionManagementError,
} from "./policy-management.js";
import { ReplayCoverageReader } from "./reader.js";
export class RetentionBusyError extends Error {
  readonly code = "retention_busy";
  constructor() {
    super("Maintenance capacity is busy; retry shortly");
  }
}
/** Host authentication supplies the actor. All heavy reads use the host's shared admission slot. */
export class RetentionManagement {
  constructor(
    private readonly policies: Pick<RetentionPolicyManagement, "get" | "save">,
    private readonly coverage: Pick<ReplayCoverageReader, "read">,
    private readonly admission: MaintenanceAdmission,
  ) {}
  private async run<T>(work: () => Promise<T>): Promise<T> {
    const result = await this.admission.tryRun(work);
    if (!result.accepted) throw new RetentionBusyError();
    return result.value;
  }
  get(actor: Actor) {
    if (!hasCapability(actor.role, "service:read"))
      throw new RetentionManagementError("forbidden");
    return this.policies.get(actor);
  }
  update(actor: Actor, raw: UpdateReplayRetention) {
    if (!hasCapability(actor.role, "service:manage"))
      throw new RetentionManagementError("forbidden");
    const input = updateReplayRetentionSchema.parse(raw);
    return this.policies.save(actor, input);
  }
  report(actor: Actor, raw: ReplayCoverageQuery) {
    if (!hasCapability(actor.role, "service:read"))
      throw new RetentionManagementError("forbidden");
    const input = replayCoverageQuerySchema.parse(raw);
    return this.run(() => this.coverage.read(actor, input));
  }
}
