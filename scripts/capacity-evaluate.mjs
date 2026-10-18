import process from "node:process";
import { error as logError } from "node:console";
import { open, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const failure = () => {
  throw new Error("Invalid capacity evidence");
};
function timestamp(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  )
    failure();
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value)
    failure();
  return time;
}
function rows(value) {
  if (!Array.isArray(value) || value.length > 100000) failure();
  return value;
}
function identity(value, seen) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ||
    seen.has(value)
  )
    failure();
  seen.add(value);
}
function measure(latencies, missing, requiredFraction) {
  const total = latencies.length + missing;
  const within = latencies.filter((value) => value <= 10000).length;
  return {
    eligible: total,
    attempted: latencies.length,
    missing,
    withinTenSeconds: within,
    fractionWithinTenSeconds: total ? within / total : null,
    requiredFraction,
    thresholdMet: total ? within / total >= requiredFraction : null,
  };
}
/** Missing attempts stay in the denominator. Input provenance is operator-supplied. */
export function evaluateCapacity(evidence) {
  if (
    !evidence ||
    evidence.formatVersion !== 1 ||
    !["standalone", "dashboard"].includes(evidence.host) ||
    evidence.clock !== "synchronized_utc" ||
    evidence.commitObservation !== "database_commit_timestamp"
  )
    failure();
  const start = timestamp(evidence.startedAt),
    end = timestamp(evidence.endedAt);
  if (end <= start) failure();
  const initials = [],
    escalations = [],
    seenIncidents = new Set(),
    seenSteps = new Set();
  let missingInitial = 0,
    missingEscalation = 0,
    acknowledgedBeforeDue = 0;
  const observedTime = (value) => {
    const time = timestamp(value);
    if (time < start || time > end) failure();
    return time;
  };
  for (const row of rows(evidence.initialPages)) {
    if (!row || typeof row !== "object") failure();
    identity(row.incidentId, seenIncidents);
    const committed = observedTime(row.committedAt);
    if (end - committed < 10000) failure(); // Do not grade an unfinished deadline window.
    if (row.firstAttemptAt === null) missingInitial++;
    else {
      const attempted = observedTime(row.firstAttemptAt);
      if (attempted < committed) failure();
      initials.push(attempted - committed);
    }
  }
  for (const row of rows(evidence.escalationSteps)) {
    if (!row || typeof row !== "object") failure();
    identity(row.stepId, seenSteps);
    const due = observedTime(row.dueAt);
    if (end - due < 10000) failure();
    if (row.acknowledgedAt !== null) {
      const acknowledged = observedTime(row.acknowledgedAt);
      if (acknowledged < due) {
        if (
          typeof row.ackEvidenceId !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(row.ackEvidenceId) ||
          row.firstAttemptAt !== null
        )
          failure();
        acknowledgedBeforeDue++;
        continue;
      }
    }
    if (row.firstAttemptAt === null) missingEscalation++;
    else {
      const attempted = observedTime(row.firstAttemptAt);
      if (attempted < due) failure();
      escalations.push(attempted - due);
    }
  }
  return {
    formatVersion: 1,
    host: evidence.host,
    durationMs: end - start,
    evidence: "operator_supplied_not_independently_verified",
    certifiesCapacityEnvelope: false,
    initialDispatch: measure(initials, missingInitial, 0.95),
    escalationDispatch: measure(escalations, missingEscalation, 0.99),
    acknowledgedBeforeDue,
    limitation:
      "Dispatch thresholds only; workload, commit instrumentation, resources, provider delivery and completeness require separate verification.",
  };
}
async function main() {
  const input = process.argv[2],
    output = process.argv[3];
  if (
    !input ||
    !output ||
    !isAbsolute(input) ||
    !isAbsolute(output) ||
    process.argv.length !== 4
  )
    failure();
  const file = await open(input, "r");
  let raw;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 8388608) failure();
    const buffer = Buffer.alloc(8388609);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        used,
        buffer.length - used,
        null,
      );
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > 8388608) failure();
    raw = buffer.subarray(0, used);
  } finally {
    await file.close();
  }
  const result = evaluateCapacity(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)),
  );
  await writeFile(output, JSON.stringify(result, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  void main().catch(() => {
    logError(
      "Capacity evidence rejected; check the bounded input schema, timestamps and unused private output path.",
    );
    process.exitCode = 1;
  });
