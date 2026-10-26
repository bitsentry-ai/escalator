import { z } from "zod";
import {
  investigationScopeSchema,
  evidenceQuerySchema,
  investigationEvidenceSchema,
  unavailableEvidenceSchema,
  type InvestigationScope,
  type EvidenceQuery,
  type UnavailableEvidence,
} from "../../contracts/index.js";
import type { EvidenceReader, OperationContext } from "../ports/index.js";
import { redactEvidence, type RedactedEvidenceText } from "./redaction.js";
const outcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("available"),
    items: z.array(investigationEvidenceSchema).max(100),
    truncated: z.boolean(),
  }),
  z.strictObject({
    status: z.literal("unavailable"),
    unavailable: unavailableEvidenceSchema,
  }),
]);
type Outcome = Awaited<ReturnType<EvidenceReader["read"]>>;
type Reason = UnavailableEvidence["reason"];
function sameScope(a: InvestigationScope, b: InvestigationScope): boolean {
  return (
    a.workspaceId === b.workspaceId &&
    a.serviceId === b.serviceId &&
    a.environmentId === b.environmentId &&
    a.incidentId === b.incidentId
  );
}
function sameQuery(a: EvidenceQuery, b: EvidenceQuery): boolean {
  return (
    a.kind === b.kind &&
    a.sourceId === b.sourceId &&
    a.limit === b.limit &&
    a.window.from === b.window.from &&
    a.window.to === b.window.to
  );
}
type EvidenceItem = z.infer<typeof investigationEvidenceSchema>;
function assertReadLimits(timeoutMs: number, maxBytes: number): void {
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120000 ||
    !Number.isInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 262144
  )
    throw new TypeError("Invalid evidence read limits");
}
/** Every item must belong to the query's scope, source and window, be unique, and carry text. */
function itemsMatchQuery(
  items: readonly EvidenceItem[],
  scope: InvestigationScope,
  query: EvidenceQuery,
): boolean {
  const ids = new Set<string>();
  for (const item of items) {
    const ref = item.reference;
    if (
      !sameScope(item.scope, scope) ||
      ref.kind !== query.kind ||
      ref.sourceId !== query.sourceId ||
      item.window.from !== query.window.from ||
      item.window.to !== query.window.to ||
      ids.has(ref.id) ||
      !item.text.trim()
    )
      return false;
    if (
      Date.parse(ref.observedAt) < Date.parse(query.window.from) ||
      Date.parse(ref.observedAt) > Date.parse(query.window.to) ||
      Date.parse(ref.receivedAt) > Date.parse(item.collectedAt) ||
      Date.parse(ref.observedAt) > Date.parse(item.collectedAt)
    )
      return false;
    ids.add(ref.id);
  }
  return true;
}
/** Redacts every item in place; false when the redactor misbehaves or leaves unusable text. */
function redactItems(
  items: EvidenceItem[],
  redact: (text: string) => RedactedEvidenceText,
): boolean {
  try {
    for (const item of items) {
      const redacted = redact(item.text);
      if (!redacted || typeof redacted.truncated !== "boolean") return false;
      item.text = redacted.text;
      item.truncated ||= redacted.truncated;
      if (
        typeof item.text !== "string" ||
        !item.text.trim() ||
        item.text.length > 16384
      )
        return false;
    }
  } catch {
    return false;
  }
  return true;
}
/** Why an available result cannot be used, or undefined; redacts the items and settles `truncated` in place. */
function availableFailure(
  result: { items: EvidenceItem[]; truncated: boolean },
  scope: InvestigationScope,
  query: EvidenceQuery,
  maxBytes: number,
  redact: (text: string) => RedactedEvidenceText,
): Reason | undefined {
  if (result.items.length === 0) return "not_found";
  if (result.items.length > query.limit) return "invalid_response";
  if (!itemsMatchQuery(result.items, scope, query)) return "invalid_response";
  result.truncated ||= result.items.some((item) => item.truncated);
  // Count metadata as well as text; non-ASCII text must not undercharge the limit.
  if (Buffer.byteLength(JSON.stringify(result.items), "utf8") > maxBytes)
    return "budget_exhausted";
  if (!redactItems(result.items, redact)) return "invalid_response";
  result.truncated ||= result.items.some((item) => item.truncated);
  if (Buffer.byteLength(JSON.stringify(result.items), "utf8") > maxBytes)
    return "budget_exhausted";
  return undefined;
}
class ReadFailure extends Error {
  constructor(readonly reason: Reason) {
    super("Evidence read failed");
  }
}
/** A validation boundary, not authorization: inner readers must authenticate the live
 * claim and scoped source, bound database/network materialization, and project/redact
 * provider data. This wrapper rejects malformed provenance before model consumption.
 */
export class ValidatedEvidenceReader implements EvidenceReader {
  constructor(
    private readonly inner: EvidenceReader,
    private readonly redact: (
      text: string,
    ) => RedactedEvidenceText = redactEvidence,
  ) {}
  async read(
    scopeInput: InvestigationScope,
    queryInput: EvidenceQuery,
    context: OperationContext & { maxBytes: number },
  ): Promise<Outcome> {
    const scope = investigationScopeSchema.parse(scopeInput);
    const query = evidenceQuerySchema.parse(queryInput);
    const { timeoutMs, maxBytes, signal: parent } = context;
    assertReadLimits(timeoutMs, maxBytes);
    const unavailable = (reason: Reason): Outcome => ({
      status: "unavailable",
      unavailable: { query, reason },
    });
    const deadline = performance.now() + timeoutMs;
    const controller = new AbortController();
    let timedOut = false;
    const stopReason = (): Reason => (timedOut ? "timeout" : "cancelled");
    let rejectAbort: (reason: ReadFailure) => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const abort = () => {
      controller.abort();
      rejectAbort(new ReadFailure(stopReason()));
    };
    parent.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      abort();
    }, timeoutMs);
    // Attach the rejection handler before observing an already-aborted parent.
    const operation = Promise.resolve().then(async () => {
      if (controller.signal.aborted) throw new ReadFailure(stopReason());
      if (performance.now() >= deadline) throw new ReadFailure("timeout");
      return this.inner.read(structuredClone(scope), structuredClone(query), {
        signal: controller.signal,
        timeoutMs,
        maxBytes,
      });
    });
    const pending = Promise.race([operation, cancelled]);
    if (parent.aborted) abort();
    try {
      const raw = await pending;
      if (controller.signal.aborted) return unavailable(stopReason());
      const parsed = outcomeSchema.safeParse(raw);
      if (!parsed.success) return unavailable("invalid_response");
      const result = parsed.data;
      if (result.status === "unavailable")
        return sameQuery(result.unavailable.query, query)
          ? result
          : unavailable("invalid_response");
      const failure = availableFailure(
        result,
        scope,
        query,
        maxBytes,
        this.redact,
      );
      if (failure) return unavailable(failure);
      if (controller.signal.aborted) return unavailable(stopReason());
      if (performance.now() >= deadline) return unavailable("timeout");
      return result;
    } catch (error) {
      if (controller.signal.aborted) return unavailable(stopReason());
      return unavailable(
        error instanceof ReadFailure ? error.reason : "unreachable",
      );
    } finally {
      clearTimeout(timer);
      parent.removeEventListener("abort", abort);
      controller.abort();
    }
  }
}
