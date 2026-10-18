export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

export function stringValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }

    return undefined;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return undefined;
}

export function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const normalized = stringValue(value);
    if (normalized !== undefined) {
      return normalized;
    }
  }

  return undefined;
}

export function truncateLegacyEvidenceText(
  value: string,
  maxChars: number,
): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxChars - 15)).trimEnd()}...[truncated]`;
}

export const legacyEvidenceValues = { asRecord, stringValue, firstString };
