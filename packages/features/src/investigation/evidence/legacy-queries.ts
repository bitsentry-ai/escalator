import { asRecord, stringValue, firstString } from "./legacy-values.js";
import type {
  LegacyDiagnosisEvidenceRequest,
  LegacyDiagnosisSourceType,
} from "./legacy-types.js";
const EVIDENCE_QUERY_WINDOW_MINUTES = 15;
function getNestedRecord(
  source: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  return asRecord(source?.[key]);
}

function getPathString(
  source: Record<string, unknown> | undefined,
  path: string[],
): string | undefined {
  let current: Record<string, unknown> | undefined = source;
  for (let index = 0; index < path.length; index += 1) {
    const key = path[index];
    if (index === path.length - 1) {
      return stringValue(current?.[key]);
    }

    current = getNestedRecord(current, key);
    if (current === undefined) {
      return undefined;
    }
  }

  return undefined;
}

function quoteWazuhQueryValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function buildTimeWindowClause(timestamp: Date): string | undefined {
  if (!Number.isFinite(timestamp.getTime())) {
    return undefined;
  }

  const windowMs = EVIDENCE_QUERY_WINDOW_MINUTES * 60 * 1000;
  const start = new Date(timestamp.getTime() - windowMs).toISOString();
  const end = new Date(timestamp.getTime() + windowMs).toISOString();
  return `@timestamp:[${start} TO ${end}]`;
}

function fieldClause(
  field: string,
  value: string | undefined,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return `${field}:${quoteWazuhQueryValue(value)}`;
}

function anyFieldClause(
  fields: string[],
  value: string | undefined,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const clauses = fields
    .map((field) => fieldClause(field, value))
    .filter((clause): clause is string => clause !== undefined);

  return `(${clauses.join(" OR ")})`;
}

function buildWazuhEvidenceQuery(
  request: LegacyDiagnosisEvidenceRequest,
  providerObject: Record<string, unknown>,
): string {
  const source = getNestedRecord(providerObject, "_source") ?? providerObject;
  const rule = getNestedRecord(source, "rule");
  const agent = getNestedRecord(source, "agent");
  const srcIp = firstString(
    getPathString(source, ["data", "srcip"]),
    getPathString(source, ["data", "src_ip"]),
    getPathString(source, ["win", "eventdata", "ipAddress"]),
    getPathString(source, ["win", "eventdata", "sourceNetworkAddress"]),
  );

  const clauses = [
    buildTimeWindowClause(request.entryTimestamp),
    fieldClause("agent.name", firstString(agent?.name, request.agentName)),
    fieldClause("agent.ip", firstString(agent?.ip, request.agentIp)),
    fieldClause("rule.id", firstString(rule?.id, request.ruleId)),
    anyFieldClause(
      [
        "data.srcip",
        "data.src_ip",
        "win.eventdata.ipAddress",
        "win.eventdata.sourceNetworkAddress",
      ],
      srcIp,
    ),
  ].filter((clause): clause is string => clause !== undefined);

  return clauses.join(" AND ");
}

function buildSentryEvidenceQuery(
  request: LegacyDiagnosisEvidenceRequest,
  providerObject: Record<string, unknown>,
): string {
  const shortIssueId = firstString(
    providerObject.shortId,
    providerObject.externalShortId,
    request.ruleId,
  );
  if (shortIssueId !== undefined) {
    return `issue:${shortIssueId}`;
  }

  return (
    firstString(
      providerObject.externalIssueId,
      providerObject.title,
      providerObject.culprit,
      providerObject.id,
      request.ruleDescription,
    ) ?? ""
  );
}

function posthogFingerprintFromExternalIssueId(
  externalIssueId: string | undefined,
): string | undefined {
  if (externalIssueId === undefined) {
    return undefined;
  }

  const separatorIndex = externalIssueId.indexOf(":");
  if (separatorIndex < 0 || separatorIndex === externalIssueId.length - 1) {
    return externalIssueId;
  }

  return externalIssueId.slice(separatorIndex + 1);
}

function buildPostHogEvidenceQuery(
  request: LegacyDiagnosisEvidenceRequest,
  providerObject: Record<string, unknown>,
): string {
  const externalIssueId = stringValue(providerObject.externalIssueId);

  return (
    firstString(
      providerObject.fingerprint,
      posthogFingerprintFromExternalIssueId(externalIssueId),
      externalIssueId,
      providerObject.externalShortId,
      request.ruleId,
      providerObject.title,
      providerObject.message,
      providerObject.exceptionType,
      providerObject.exception_type,
      providerObject.id,
      request.ruleDescription,
    ) ?? ""
  );
}

function buildGitHubEvidenceQuery(
  request: LegacyDiagnosisEvidenceRequest,
  providerObject: Record<string, unknown>,
): string {
  const term = firstString(
    providerObject.title,
    providerObject.externalIssueId,
    providerObject.externalShortId,
    providerObject.message,
    request.ruleId,
    request.ruleDescription,
  );

  if (term === undefined) {
    return "is:issue";
  }

  return `is:issue "${term.replace(/"/g, "")}"`;
}

export function buildLegacyEvidenceQuery(
  sourceType: LegacyDiagnosisSourceType,
  request: LegacyDiagnosisEvidenceRequest,
  providerObject: Record<string, unknown>,
): string {
  if (sourceType === "wazuh") {
    return buildWazuhEvidenceQuery(request, providerObject);
  }

  if (sourceType === "posthog") {
    return buildPostHogEvidenceQuery(request, providerObject);
  }

  if (sourceType === "github") {
    return buildGitHubEvidenceQuery(request, providerObject);
  }

  return buildSentryEvidenceQuery(request, providerObject);
}
