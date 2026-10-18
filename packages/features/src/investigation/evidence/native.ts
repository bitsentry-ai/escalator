import { z } from "zod";
import {
  investigationScopeSchema,
  evidenceQuerySchema,
  utcTimestampSchema,
  serviceIdSchema,
  environmentIdSchema,
  opaqueIdSchema,
  probeResultSchema,
  metricObservationSchema,
  signalEventSchema,
  deploymentSchema,
  investigationEvidenceSchema,
  type InvestigationScope,
  type EvidenceQuery,
  type InvestigationEvidence,
} from "../../contracts/index.js";
import { pagingWorkId } from "../../application/paging/work-ids.js";
import { redactEvidence } from "./redaction.js";
import type { EvidenceReader } from "../ports/index.js";
const placement = {
  serviceId: serviceIdSchema,
  environmentId: environmentIdSchema,
};
/** Host query supplies stored receipt timestamps and actual relational scope.
 * Never synthesize receipt time for legacy observations lacking it. */
export const nativeEvidenceRowSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("probe"),
    ...placement,
    receivedAt: utcTimestampSchema,
    record: probeResultSchema,
  }),
  z.strictObject({
    kind: z.literal("metric"),
    ...placement,
    record: metricObservationSchema,
  }),
  z.strictObject({ kind: z.literal("alert"), record: signalEventSchema }),
  z.strictObject({
    kind: z.literal("deployment"),
    targetId: opaqueIdSchema,
    event: z.enum(["start", "finish", "timeout"]),
    record: deploymentSchema,
  }),
]);
export type NativeEvidenceRow = z.infer<typeof nativeEvidenceRowSchema>;
type Outcome = Awaited<ReturnType<EvidenceReader["read"]>>;
function projection(row: NativeEvidenceRow) {
  switch (row.kind) {
    case "probe":
      return {
        id: row.record.id,
        sourceId: row.record.probeId,
        serviceId: row.serviceId,
        environmentId: row.environmentId,
        observedAt: row.record.observedAt,
        receivedAt: row.receivedAt,
        facts: {
          outcome: row.record.outcome,
          reason: row.record.reason,
          statusCode: row.record.statusCode,
          durationMs: row.record.durationMs,
          version: row.record.probeVersion,
        },
      };
    case "metric":
      return {
        id: row.record.id,
        sourceId: row.record.monitorId,
        serviceId: row.serviceId,
        environmentId: row.environmentId,
        observedAt: row.record.observedAt,
        receivedAt: row.record.receivedAt,
        facts: {
          reason: row.record.reason,
          sample: row.record.sample,
          evaluation: row.record.evaluation,
          version: row.record.monitorVersion,
        },
      };
    case "alert":
      return {
        id: row.record.id,
        sourceId: row.record.sourceId,
        serviceId: row.record.serviceId,
        environmentId: row.record.environmentId,
        observedAt: row.record.observedAt,
        receivedAt: row.record.receivedAt,
        facts: {
          status: row.record.status,
          severity: row.record.severity,
          title: row.record.title,
          summary: row.record.evidence.summary,
        },
      };
    case "deployment": {
      const deployment = row.record;
      const base = {
        id: deployment.id,
        sourceId: row.targetId,
        serviceId: deployment.serviceId,
        environmentId: deployment.environmentId,
      };
      // Start evidence must not inherit a finish that happened after this query window.
      if (row.event === "start")
        return {
          ...base,
          observedAt: deployment.startedAt,
          receivedAt: deployment.acceptedAt,
          facts: {
            event: "start",
            commit: deployment.commit,
            artifact: deployment.artifact,
          },
        };
      if (row.event === "finish" && deployment.finish)
        return {
          ...base,
          observedAt: deployment.finish.occurredAt,
          receivedAt: deployment.finish.receivedAt,
          facts: {
            event: "finish",
            outcome: deployment.finish.outcome,
            commit: deployment.commit,
            artifact: deployment.artifact,
          },
        };
      if (row.event === "timeout" && deployment.timedOutAt)
        return {
          ...base,
          observedAt: deployment.timedOutAt,
          receivedAt: deployment.timedOutAt,
          facts: {
            event: "timeout",
            commit: deployment.commit,
            artifact: deployment.artifact,
          },
        };
      throw new Error("Missing deployment event");
    }
  }
}
/** Projection/validation only, never authorization. Hosts must fence the live claim and
 * approved source before scoped SQL, bound rows before materialization, and release the
 * transaction before model I/O. Never serialize these input records into prompts. */
export function normalizeNativeEvidence(
  scopeInput: InvestigationScope,
  queryInput: EvidenceQuery,
  rowsInput: unknown,
  collectedAtInput: string,
  maxBytes: number,
  incomplete = false,
): Outcome {
  const scope = investigationScopeSchema.parse(scopeInput);
  const query = evidenceQuerySchema.parse(queryInput);
  const collectedAt = utcTimestampSchema.parse(collectedAtInput);
  if (typeof incomplete !== "boolean")
    throw new TypeError("Invalid evidence completeness flag");
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 262144)
    throw new RangeError("Invalid evidence byte limit");
  const unavailable = (
    reason:
      | "not_configured"
      | "not_found"
      | "invalid_response"
      | "budget_exhausted",
  ): Outcome => ({ status: "unavailable", unavailable: { query, reason } });
  if (query.kind === "log" || query.kind === "git_diff")
    return unavailable("not_configured");
  if (!Array.isArray(rowsInput) || rowsInput.length > query.limit + 1)
    return unavailable("invalid_response");
  if (!rowsInput.length) return unavailable("not_found");
  try {
    const candidates: InvestigationEvidence[] = [];
    const ids = new Set<string>();
    for (const raw of rowsInput) {
      const row = nativeEvidenceRowSchema.parse(raw);
      const item = projection(row);
      if (
        row.kind !== query.kind ||
        row.record.workspaceId !== scope.workspaceId ||
        item.sourceId !== query.sourceId ||
        item.serviceId !== scope.serviceId ||
        item.environmentId !== scope.environmentId ||
        Date.parse(item.observedAt) < Date.parse(query.window.from) ||
        Date.parse(item.observedAt) > Date.parse(query.window.to) ||
        Date.parse(item.observedAt) > Date.parse(collectedAt) ||
        Date.parse(item.receivedAt) > Date.parse(collectedAt)
      )
        throw new Error("Evidence provenance mismatch");
      const id = pagingWorkId(
        scope.workspaceId,
        "native-evidence",
        row.kind,
        item.sourceId,
        item.id,
        row.kind === "deployment" ? row.event : "observation",
      );
      if (ids.has(id)) throw new Error("Duplicate evidence");
      ids.add(id);
      const redacted = redactEvidence(JSON.stringify(item.facts));
      candidates.push(
        investigationEvidenceSchema.parse({
          scope,
          reference: {
            id,
            kind: row.kind,
            sourceId: item.sourceId,
            observedAt: item.observedAt,
            receivedAt: item.receivedAt,
          },
          window: query.window,
          collectedAt,
          text: redacted.text,
          truncated: redacted.truncated,
        }),
      );
    }
    const items: InvestigationEvidence[] = [];
    let bytes = 2;
    let truncated = incomplete || candidates.length > query.limit;
    for (const item of candidates.slice(0, query.limit)) {
      const size =
        Buffer.byteLength(JSON.stringify(item), "utf8") +
        (items.length ? 1 : 0);
      if (bytes + size > maxBytes) {
        truncated = true;
        break;
      }
      items.push(item);
      bytes += size;
      truncated ||= item.truncated;
    }
    return items.length
      ? { status: "available", items, truncated }
      : unavailable("budget_exhausted");
  } catch {
    return unavailable("invalid_response");
  }
}
