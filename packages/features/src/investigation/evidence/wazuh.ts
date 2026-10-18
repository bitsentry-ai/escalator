import { createHash } from "node:crypto";
import { z } from "zod";
import {
  investigationScopeSchema,
  evidenceQuerySchema,
  opaqueIdSchema,
  utcTimestampSchema,
  type InvestigationScope,
  type EvidenceQuery,
  type InvestigationEvidence,
} from "../../contracts/index.js";
import { redactEvidence } from "./redaction.js";
export const wazuhEvidenceBindingSchema = z.strictObject({
  scope: investigationScopeSchema,
  sourceId: opaqueIdSchema,
  sourceName: z.string().trim().min(1).max(200),
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  agentIds: z
    .array(z.string().regex(/^\d{1,8}$/))
    .min(1)
    .max(100),
  indexPattern: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9_.?*-]+$/),
  timestampField: z.enum(["@timestamp", "timestamp"]),
});
export type WazuhEvidenceBinding = z.infer<typeof wazuhEvidenceBindingSchema>;
export class WazuhEvidenceError extends Error {
  constructor(
    readonly reason: "not_authorized" | "invalid_response" | "budget_exhausted",
  ) {
    super("Wazuh evidence is unavailable");
  }
}
/** Scope and selectors must come from a live host grant, never model output. */
export function prepareWazuhEvidence(
  scopeInput: InvestigationScope,
  queryInput: EvidenceQuery,
  bindingInput: WazuhEvidenceBinding,
) {
  const scope = investigationScopeSchema.parse(scopeInput);
  const query = evidenceQuerySchema.parse(queryInput);
  const parsed = wazuhEvidenceBindingSchema.safeParse(bindingInput);
  if (!parsed.success) throw new WazuhEvidenceError("not_authorized");
  const binding = parsed.data;
  if (
    query.kind !== "log" ||
    query.sourceId !== binding.sourceId ||
    (Object.keys(scope) as Array<keyof InvestigationScope>).some(
      (key) => scope[key] !== binding.scope[key],
    )
  )
    throw new WazuhEvidenceError("not_authorized");
  const agents = [...new Set(binding.agentIds)]
    .map((id) => '"' + id + '"')
    .join(" OR ");
  return {
    scope,
    query,
    binding,
    search: `${binding.timestampField}:[${query.window.from} TO ${query.window.to}] AND agent.id:(${agents})`,
  };
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
/** Bounded glob matching, without turning a configured wildcard into a backtracking regexp. */
function indexMatches(pattern: string, value: string): boolean {
  let previous = Array<boolean>(value.length + 1).fill(false);
  previous[0] = true;
  for (const token of pattern) {
    const next = Array<boolean>(value.length + 1).fill(false);
    next[0] = token === "*" && previous[0];
    for (let i = 1; i <= value.length; i++)
      next[i] =
        token === "*"
          ? previous[i] || next[i - 1]
          : previous[i - 1] && (token === "?" || token === value[i - 1]);
    previous = next;
  }
  return previous[value.length];
}
function eventTime(value: unknown): string {
  if (typeof value !== "string" || value.length > 64)
    throw new WazuhEvidenceError("invalid_response");
  const canonicalOffset = value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  if (!z.string().datetime({ offset: true }).safeParse(canonicalOffset).success)
    throw new WazuhEvidenceError("invalid_response");
  const date = new Date(canonicalOffset);
  if (!Number.isFinite(date.getTime()))
    throw new WazuhEvidenceError("invalid_response");
  return date.toISOString();
}
function safeHttpUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    // Parse relative paths without requesting the synthetic origin.
    const parsed = new URL(value, "https://evidence.invalid");
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      return "[URL REDACTED]";
    return value;
  } catch {
    return "[URL REDACTED]";
  }
}
/** Raw response bodies must already be capped by the host executor before JSON parsing.
 * receivedAt records this retrieval's availability, not a guessed historical ingest time.
 */
export function normalizeWazuhEvidence(
  scope: InvestigationScope,
  query: EvidenceQuery,
  binding: WazuhEvidenceBinding,
  input: { items: unknown[]; hasMore: boolean },
  collectedAt: string,
):
  | { status: "available"; items: InvestigationEvidence[]; truncated: boolean }
  | {
      status: "unavailable";
      unavailable: { query: EvidenceQuery; reason: "not_found" };
    } {
  const prepared = prepareWazuhEvidence(scope, query, binding);
  const collected = utcTimestampSchema.parse(collectedAt);
  if (
    !Array.isArray(input.items) ||
    input.items.length > prepared.query.limit ||
    typeof input.hasMore !== "boolean"
  )
    throw new WazuhEvidenceError("invalid_response");
  if (!input.items.length)
    return {
      status: "unavailable",
      unavailable: { query: prepared.query, reason: "not_found" },
    };
  const seen = new Set<string>();
  const items = input.items.map((raw) => {
    const item = record(raw);
    const hit = record(item?.rawAlert) ?? item;
    const source = record(hit?._source);
    const agent = record(source?.agent);
    const id = hit?._id;
    const index = hit?._index;
    const agentId = agent?.id;
    if (
      typeof id !== "string" ||
      !id ||
      id.length > 512 ||
      typeof index !== "string" ||
      !/^[A-Za-z0-9_.-]{1,256}$/.test(index) ||
      !indexMatches(prepared.binding.indexPattern, index) ||
      typeof agentId !== "string" ||
      !prepared.binding.agentIds.includes(agentId)
    )
      throw new WazuhEvidenceError("invalid_response");
    const locator = JSON.stringify([index, id]);
    if (seen.has(locator)) throw new WazuhEvidenceError("invalid_response");
    seen.add(locator);
    const observedAt = eventTime(source?.[prepared.binding.timestampField]);
    if (
      Date.parse(observedAt) < Date.parse(prepared.query.window.from) ||
      Date.parse(observedAt) > Date.parse(prepared.query.window.to) ||
      Date.parse(observedAt) > Date.parse(collected)
    )
      throw new WazuhEvidenceError("invalid_response");
    let truncated = false;
    const text = (value: unknown, max: number): string | undefined => {
      if (value === undefined) return undefined;
      if (typeof value !== "string" || value.length > max) {
        truncated = true;
        return "[OMITTED]";
      }
      return value;
    };
    const rule = record(source?.rule);
    const data = record(source?.data);
    const decoder = record(source?.decoder);
    const status = data?.id;
    const projected = {
      provider: "wazuh",
      record: { index, id },
      agentId,
      rule: {
        id: text(
          typeof rule?.id === "number" ? String(rule.id) : rule?.id,
          128,
        ),
        level:
          typeof rule?.level === "number" &&
          Number.isInteger(rule.level) &&
          rule.level >= 0 &&
          rule.level <= 16
            ? rule.level
            : undefined,
        description: text(rule?.description, 4000),
      },
      message: text(source?.full_log ?? source?.message, 8000),
      http:
        decoder?.name === "web-accesslog"
          ? {
              status:
                typeof status === "string" && /^[1-5]\d{2}$/.test(status)
                  ? Number(status)
                  : undefined,
              method: text(data?.protocol, 20),
              url: safeHttpUrl(text(data?.url, 2048)),
              sourceIp: text(data?.srcip, 100),
            }
          : undefined,
    };
    let redacted = redactEvidence(JSON.stringify(projected));
    if (redacted.text.length > 16384) {
      projected.message = "[OMITTED]";
      truncated = true;
      redacted = redactEvidence(JSON.stringify(projected));
    }
    if (redacted.text.length > 16384)
      throw new WazuhEvidenceError("budget_exhausted");
    const evidenceId =
      "wazuh:" +
      createHash("sha256")
        .update(
          JSON.stringify([
            prepared.scope,
            prepared.binding.sourceId,
            index,
            id,
            observedAt,
            collected,
            redacted.text,
          ]),
        )
        .digest("hex");
    return {
      reference: {
        id: evidenceId,
        kind: "log" as const,
        sourceId: prepared.binding.sourceId,
        observedAt,
        receivedAt: collected,
      },
      scope: prepared.scope,
      collectedAt: collected,
      window: prepared.query.window,
      text: redacted.text,
      truncated: truncated || redacted.truncated,
    };
  });
  return {
    status: "available",
    items,
    truncated: input.hasMore || items.some((item) => item.truncated),
  };
}
