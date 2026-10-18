import { z } from "zod";
import { opaqueIdSchema } from "./identity.js";
import { utcTimestampSchema } from "./entities.js";
import {
  investigationScopeSchema,
  investigationReportSchema,
  investigationEvidenceSchema,
  modelDestinationSchema,
} from "./investigation.js";
/** Host execution configuration is not a liveness or health assertion. */
export const investigationExecutionAvailabilitySchema = z.enum([
  "configured",
  "disabled",
  "integration_required",
]);
export const investigationViewSchema = z
  .strictObject({
    scope: investigationScopeSchema,
    execution: investigationExecutionAvailabilitySchema,
    observedAt: utcTimestampSchema,
    run: z
      .strictObject({
        id: opaqueIdSchema,
        state: z.enum([
          "queued",
          "running",
          "awaiting_reclaim",
          "failed",
          "cancelled",
          "reported",
          "report_unavailable",
        ]),
        attempts: z.number().int().min(0).max(5),
        createdAt: utcTimestampSchema,
        updatedAt: utcTimestampSchema,
        destination: modelDestinationSchema,
        report: investigationReportSchema.nullable(),
        evidence: z.array(investigationEvidenceSchema).max(128),
        missingEvidenceIds: z.array(opaqueIdSchema).max(128),
      })
      .nullable(),
  })
  .superRefine((view, context) => {
    const run = view.run;
    if (!run) return;
    const invalid = () =>
      context.addIssue({
        code: "custom",
        message: "Inconsistent investigation view",
      });
    if (Date.parse(run.updatedAt) < Date.parse(run.createdAt)) invalid();
    if ((run.state === "reported") !== (run.report !== null)) invalid();
    const key = (scope: z.infer<typeof investigationScopeSchema>) =>
      JSON.stringify([
        scope.workspaceId,
        scope.serviceId,
        scope.environmentId,
        scope.incidentId,
      ]);
    const report = run.report;
    if (!report) {
      if (run.evidence.length || run.missingEvidenceIds.length) invalid();
      return;
    }
    if (report.id !== run.id || key(report.scope) !== key(view.scope))
      invalid();
    if (
      report.destination &&
      JSON.stringify(report.destination) !== JSON.stringify(run.destination)
    )
      invalid();
    const references = new Map(report.evidence.map((item) => [item.id, item]));
    const retained = new Set<string>();
    for (const item of run.evidence) {
      const expected = references.get(item.reference.id);
      if (
        key(item.scope) !== key(view.scope) ||
        !expected ||
        JSON.stringify(expected) !== JSON.stringify(item.reference) ||
        retained.has(item.reference.id)
      )
        invalid();
      retained.add(item.reference.id);
    }
    const missing = new Set(run.missingEvidenceIds);
    if (missing.size !== run.missingEvidenceIds.length) invalid();
    for (const id of missing)
      if (!references.has(id) || retained.has(id)) invalid();
    for (const id of references.keys())
      if (!retained.has(id) && !missing.has(id)) invalid();
  });
export type InvestigationView = z.infer<typeof investigationViewSchema>;
export type InvestigationExecutionAvailability = z.infer<
  typeof investigationExecutionAvailabilitySchema
>;
