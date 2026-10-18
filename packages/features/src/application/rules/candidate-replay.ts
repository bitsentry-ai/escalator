import { createHash } from "node:crypto";
import {
  storedRuleReplaySnapshotSchema,
  type StoredRuleReplaySnapshot,
} from "../../contracts/replay-run.js";
import {
  detectionRuleVersionSchema,
  type DetectionRuleVersion,
} from "../../contracts/rule-state.js";
import { ruleReplaySnapshotSchema } from "../../contracts/rule-replay.js";
import type { RulePolicyFact } from "../../contracts/rule-policy.js";
import { compareUtcTimestamps } from "../../contracts/timestamps.js";
import { PersistenceError } from "../ports/persistence.js";
import { pagingWorkId } from "../paging/work-ids.js";
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Full candidate replay from the original immutable capture. Longer lookbacks
 * shorten the available decision interval; they never fabricate earlier history. */
export function deriveCandidateReplay(
  raw: StoredRuleReplaySnapshot,
  candidateRaw: DetectionRuleVersion,
): StoredRuleReplaySnapshot {
  const source = storedRuleReplaySnapshotSchema.parse(raw),
    s = source.snapshot,
    version = detectionRuleVersionSchema.parse(candidateRaw),
    d = version.definition,
    old = s.version.definition;
  if (
    hash(s) !== source.inputHash ||
    s.evaluation ||
    s.candidateEvaluation ||
    !s.retained
  )
    throw new Error("Candidate replay requires an original intact capture");
  if (
    d.workspaceId !== source.workspaceId ||
    d.serviceId !== old.serviceId ||
    d.environmentId !== old.environmentId ||
    JSON.stringify(d.selector) !== JSON.stringify(old.selector)
  )
    throw new PersistenceError("scope_violation");
  if (
    version.revision !== 1 ||
    version.id === s.version.id ||
    d.stepSeconds !== old.stepSeconds ||
    (d.collectionDelaySeconds ?? 0) !== (old.collectionDelaySeconds ?? 0) ||
    d.severity !== old.severity
  )
    throw new Error("Candidate changed a fixed field");
  const step = d.stepSeconds * 1000,
    delay = (d.collectionDelaySeconds ?? 0) * 1000;
  const first = Math.max(
    Date.parse(s.firstDecisionAt),
    Math.ceil(
      (Date.parse(s.retained.history.startAt) +
        delay +
        d.windowSeconds * 1000) /
        step,
    ) * step,
  );
  if (first > Date.parse(s.lastDecisionAt))
    throw new Error("Candidate has no captured decision window");
  const firstDecisionAt = new Date(first).toISOString(),
    startAt = new Date(first - delay - d.windowSeconds * 1000).toISOString();
  if (compareUtcTimestamps(startAt, s.retained.history.startAt) < 0)
    throw new Error("Candidate exceeds captured history");
  const sameRange =
    compareUtcTimestamps(firstDecisionAt, s.firstDecisionAt) === 0;
  // Retain exactly what a capture of the narrowed range returns (slot > startAt;
  // newest earlier fact per entity), so review can re-read the same evidence.
  const prior = new Map<string, RulePolicyFact>();
  for (const f of s.retained.policyFacts) {
    const key = f.kind + "|" + f.entityId,
      seen = prior.get(key);
    if (
      compareUtcTimestamps(f.recordedAt, startAt) < 0 &&
      (!seen ||
        (compareUtcTimestamps(f.recordedAt, seen.recordedAt) ||
          (BigInt(f.id) > BigInt(seen.id) ? 1 : -1)) > 0)
    )
      prior.set(key, f);
  }
  const policyFacts = s.retained.policyFacts.filter(
    (f) =>
      compareUtcTimestamps(f.recordedAt, startAt) >= 0 ||
      prior.get(f.kind + "|" + f.entityId) === f,
  );
  const receipts = s.retained.history.receipts.filter(
    ({ sample }) =>
      compareUtcTimestamps(
        (sample.kind !== "signal" && sample.slotAt) || sample.observedAt,
        startAt,
      ) > 0,
  );
  const snapshot = ruleReplaySnapshotSchema.parse({
    ...s,
    version,
    firstDecisionAt,
    snapshotId: pagingWorkId(
      source.workspaceId,
      "rule-candidate-snapshot",
      s.snapshotId,
    ),
    candidateEvaluation: {
      kind: "candidate",
      sourceSnapshotId: s.snapshotId,
      sourceInputHash: source.inputHash,
      candidateHash: hash(version),
      firstDecisionAt,
      lastDecisionAt: s.lastDecisionAt,
    },
    retained: {
      ...s.retained,
      history: { ...s.retained.history, startAt, receipts },
      policyFacts,
      ...(!sameRange ? { baselines: undefined } : {}),
    },
  });
  return storedRuleReplaySnapshotSchema.parse({
    workspaceId: source.workspaceId,
    snapshot,
    inputHash: hash(snapshot),
  });
}
