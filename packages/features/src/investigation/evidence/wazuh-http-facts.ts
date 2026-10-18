function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
// Preserve the existing decoded-facts semantics: no trimming or numeric coercion.
function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Preserve decoded access-log facts independently of generic JSON compaction. */
export function getWazuhHttpFacts(entrySource: unknown) {
  if (!isRecord(entrySource)) return undefined;

  const hit = isRecord(entrySource.hit) ? entrySource.hit : entrySource;
  const source = isRecord(hit._source) ? hit._source : hit;
  const decoder = isRecord(source.decoder) ? source.decoder : undefined;
  const data = isRecord(source.data) ? source.data : undefined;
  if (decoder?.name !== "web-accesslog" || data === undefined) {
    return undefined;
  }

  // `data.id` has provider-specific meanings outside the access-log decoder.
  const status = stringValue(data.id);
  const httpStatus =
    status !== undefined && /^[1-5]\d{2}$/.test(status)
      ? Number(status)
      : undefined;

  return {
    httpStatus,
    method: stringValue(data.protocol),
    url: stringValue(data.url)?.slice(0, 2_048),
    sourceIp: stringValue(data.srcip),
  };
}

export const HTTP_EVIDENCE_GUIDANCE =
  "For web-accesslog events, HTTP facts are decoded event values: data.id is the HTTP response status and data.protocol is the request method. Rule descriptions are classification labels, not exact event facts. Prefer decoded fields and raw logs over rule descriptions; never infer an exact status from a rule title. If decoded fields and raw logs disagree, report the discrepancy. Do not infer successful exploitation from an HTTP status or probe path alone.";
