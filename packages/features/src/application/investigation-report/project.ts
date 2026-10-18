import { z } from "zod";
import {
  investigationScopeSchema,
  investigationReportSchema,
  investigationEvidenceSchema,
  modelDestinationSchema,
  investigationViewSchema,
  utcTimestampSchema,
  opaqueIdSchema,
  type InvestigationScope,
  type InvestigationView,
  type InvestigationExecutionAvailability,
} from "../../contracts/index.js";
const rowSchema = z.strictObject({
  id: opaqueIdSchema,
  scope: investigationScopeSchema,
  state: z.enum(["pending", "running", "completed", "failed", "cancelled"]),
  attempts: z.number().int().min(0).max(5),
  createdAt: utcTimestampSchema,
  updatedAt: utcTimestampSchema,
  leaseExpiresAt: utcTimestampSchema.nullable(),
  destination: modelDestinationSchema,
  report: z.unknown(),
  evidence: z.array(z.unknown()).max(128),
});
function sameScope(a: InvestigationScope, b: InvestigationScope) {
  return (
    a.workspaceId === b.workspaceId &&
    a.serviceId === b.serviceId &&
    a.environmentId === b.environmentId &&
    a.incidentId === b.incidentId
  );
}
/** Host reads the approved row projection, report and snapshots in one database snapshot.
 * It never passes job payload, claim tokens, raw errors or complete configuration here. */
export function projectInvestigationView(
  scopeInput: InvestigationScope,
  execution: InvestigationExecutionAvailability,
  observedAtInput: string,
  input: unknown | null,
): InvestigationView {
  const scope = investigationScopeSchema.parse(scopeInput);
  const observedAt = utcTimestampSchema.parse(observedAtInput);
  if (input === null)
    return investigationViewSchema.parse({
      scope,
      execution,
      observedAt,
      run: null,
    });
  const row = rowSchema.parse(input);
  if (!sameScope(scope, row.scope))
    throw new Error("Investigation scope mismatch");
  let state: NonNullable<InvestigationView["run"]>["state"];
  if (row.state === "running") {
    if (row.leaseExpiresAt === null)
      throw new Error("Missing investigation lease");
    state =
      Date.parse(row.leaseExpiresAt) > Date.parse(observedAt)
        ? "running"
        : "awaiting_reclaim";
  } else if (row.state === "pending") state = "queued";
  else if (row.state === "failed" || row.state === "cancelled")
    state = row.state;
  else state = row.report === null ? "report_unavailable" : "reported";
  if (row.state !== "completed" && row.report !== null)
    throw new Error("Inconsistent investigation result");
  const report =
    row.report === null ? null : investigationReportSchema.parse(row.report);
  const evidence = row.evidence.map((value) =>
    investigationEvidenceSchema.parse(value),
  );
  const seen = new Set(evidence.map((item) => item.reference.id));
  const references = report?.evidence ?? [];
  return investigationViewSchema.parse({
    scope,
    execution,
    observedAt,
    run: {
      id: row.id,
      state,
      attempts: row.attempts,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      destination: row.destination,
      report,
      evidence,
      missingEvidenceIds: references
        .map((item) => item.id)
        .filter((id) => !seen.has(id)),
    },
  });
}
