const MASK = "[REDACTED]";
const secretKey =
  /(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|private[_-]?key|client[_-]?secret|credential)/i;
const assignment =
  /(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|private[_-]?key|client[_-]?secret|credential)[\w-]*["']?\s*[:=]/i;
/** Bounded defense in depth. Hosts must still project approved fields rather than raw
 * credential objects. No heuristic can discover every secret in arbitrary prose.
 * Known values are held only by this call; the helper keeps no global cache.
 */
export interface RedactedEvidenceText {
  text: string;
  truncated: boolean;
}
export function redactEvidence(
  text: string,
  knownSecrets: readonly string[] = [],
): RedactedEvidenceText {
  if (
    typeof text !== "string" ||
    Buffer.byteLength(text, "utf8") > 262144 ||
    !Array.isArray(knownSecrets) ||
    knownSecrets.length > 128 ||
    knownSecrets.some(
      (value) => typeof value !== "string" || !value || value.length > 8192,
    ) ||
    knownSecrets.reduce((sum, value) => sum + value.length, 0) > 32768
  )
    throw new TypeError("Invalid redaction input");
  const representations = [
    ...new Set(
      knownSecrets.flatMap((secret) => [
        secret,
        encodeURIComponent(secret),
        JSON.stringify(secret).slice(1, -1),
      ]),
    ),
  ].sort((a, b) => b.length - a.length);
  const escaped = representations.map((value) =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  const knownPattern = escaped.length
    ? new RegExp(escaped.join("|"), "gi")
    : undefined;
  // Conservative case-insensitive masking also covers percent-escape hex case.
  // One pass: replacements must never become input to subsequent secret matching.
  const replaceKnown = (value: string): string =>
    knownPattern ? value.replace(knownPattern, () => MASK) : value;
  const prose = (value: string): string => {
    const withoutKeys = value.replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
      MASK,
    );
    const lines = withoutKeys.split(/\r?\n/);
    let maskNext = false;
    return replaceKnown(
      lines
        .map((line) => {
          if (maskNext) {
            maskNext = false;
            return MASK;
          }
          if (assignment.test(line)) {
            maskNext = /[:=]\s*$/.test(line);
            return MASK;
          }
          return line
            .replace(/\b(?:Bearer|Basic)\s+[^\s"'<>]+/gi, MASK)
            .replace(
              /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
              MASK,
            )
            .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (raw) => {
              try {
                const url = new URL(raw);
                if (url.username || url.password || url.search || url.hash)
                  return "[URL REDACTED]";
                return raw;
              } catch {
                return "[URL REDACTED]";
              }
            });
        })
        .join("\n"),
    );
  };
  let nodes = 0;
  let truncated = false;
  const structured = (value: unknown, depth: number): unknown => {
    if (++nodes > 4096 || depth > 12) {
      truncated = true;
      return "[OMITTED]";
    }
    if (typeof value === "string") return prose(value);
    if (Array.isArray(value)) {
      truncated ||= value.length > 100;
      return value.slice(0, 100).map((item) => structured(item, depth + 1));
    }
    if (value && typeof value === "object") {
      const entries = Object.entries(value);
      truncated ||= entries.length > 100;
      return Object.fromEntries(
        entries
          .slice(0, 100)
          .map(([key, item]) => [
            prose(key),
            secretKey.test(key) ? MASK : structured(item, depth + 1),
          ]),
      );
    }
    return value;
  };
  let result: string;
  try {
    result = JSON.stringify(structured(JSON.parse(text), 0));
  } catch {
    result = prose(text);
  }
  // Escaping can enlarge JSON; fail closed instead of returning unbounded output.
  if (Buffer.byteLength(result, "utf8") > 262144)
    return { text: "[OMITTED]", truncated: true };
  return { text: result, truncated };
}
export function redactEvidenceText(
  text: string,
  knownSecrets: readonly string[] = [],
): string {
  return redactEvidence(text, knownSecrets).text;
}
