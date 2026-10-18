import {
  deploymentCoverageBindingSchema,
  deploymentCoverageDecisionSchema,
  deploymentCoverageEvaluationSchema,
  coverageOverrideReasonSchema,
  hasCapability,
  utcTimestampSchema,
  type Actor,
  type DeploymentCoverageBinding,
  type DeploymentCoverageDecision,
  type DeploymentCoverageEvaluation,
} from "../../contracts/index.js";
export class DeploymentPreflightError extends Error {
  constructor(
    readonly code: "forbidden" | "invalid_override" | "scope_violation",
  ) {
    super(code);
  }
}
export function coverageDecision(input: {
  id: string;
  binding: DeploymentCoverageBinding;
  evaluation: DeploymentCoverageEvaluation;
  now: string;
  override?: { actor: Actor; reason: string };
}): DeploymentCoverageDecision {
  let override: DeploymentCoverageDecision["override"] = null;
  if (input.override) {
    const { actor, reason } = input.override;
    if (actor.workspaceId !== input.binding.workspaceId)
      throw new DeploymentPreflightError("scope_violation");
    if (!hasCapability(actor.role, "deployment:override"))
      throw new DeploymentPreflightError("forbidden");
    const parsed = coverageOverrideReasonSchema.safeParse(reason);
    if (!parsed.success) throw new DeploymentPreflightError("invalid_override");
    override = { responderId: actor.responderId, reason: parsed.data };
  }
  const now = new Date(utcTimestampSchema.parse(input.now)).toISOString();
  return deploymentCoverageDecisionSchema.parse({
    id: input.id,
    binding: input.binding,
    evaluation: input.evaluation,
    evaluatedAt: now,
    expiresAt: new Date(Date.parse(now) + 120000).toISOString(),
    override,
  });
}
/** Caller must compare current evidence even before expiry: hours and shifts can change with time. */
export function coverageDecisionState(
  raw: DeploymentCoverageDecision,
  rawBinding: DeploymentCoverageBinding,
  current: DeploymentCoverageEvaluation,
  at: string,
): "allow" | "block" | "expired" | "stale" | "binding_mismatch" {
  const decision = deploymentCoverageDecisionSchema.parse(raw);
  current = deploymentCoverageEvaluationSchema.parse(current);
  const binding = deploymentCoverageBindingSchema.parse(rawBinding);
  if (JSON.stringify(decision.binding) !== JSON.stringify(binding))
    return "binding_mismatch";
  const now = Date.parse(utcTimestampSchema.parse(at));
  if (
    now < Date.parse(decision.evaluatedAt) ||
    now >= Date.parse(decision.expiresAt)
  )
    return "expired";
  if (current.fingerprint !== decision.evaluation.fingerprint) return "stale";
  return decision.override !== null || current.decision === "allow"
    ? "allow"
    : "block";
}
