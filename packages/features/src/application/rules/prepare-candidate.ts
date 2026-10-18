import { createHash } from "node:crypto";
import { opaqueIdSchema } from "../../contracts/identity.js";
import {
  storedRuleReplaySnapshotSchema,
  type StoredRuleReplaySnapshot,
} from "../../contracts/replay-run.js";
import type { IncidentLabel } from "../../contracts/rule-label.js";
import {
  ruleCandidateInputSchema,
  ruleCandidateParameterKeys as parameterKeys,
  ruleCandidateParametersSchema as parameters,
  type RuleCandidateInput,
} from "../../contracts/rule-candidate-input.js";
import { trainingRuleEvidence } from "./tuning.js";
export interface RuleCandidatePreparation {
  source: StoredRuleReplaySnapshot;
  labels: readonly IncidentLabel[];
  profileId: string;
  candidateId: string;
}
/** Prepare while the host owns a live claim. Withheld rows and raw text are
 * deliberately absent from the resulting message, including diagnostic counts. */
export function prepareRuleCandidate(
  input: RuleCandidatePreparation,
): RuleCandidateInput {
  const profileId = opaqueIdSchema.parse(input.profileId),
    candidateId = opaqueIdSchema.parse(input.candidateId);
  const source = storedRuleReplaySnapshotSchema.parse(input.source),
    s = source.snapshot;
  if (candidateId === s.version.id)
    throw new Error("Candidate requires a new rule ID");
  if (
    s.evaluation ||
    s.candidateEvaluation ||
    createHash("sha256").update(JSON.stringify(s)).digest("hex") !==
      source.inputHash
  )
    throw new Error("Invalid training capture");
  const projected = trainingRuleEvidence(s, input.labels),
    rule = s.version.definition;
  // Do not serialize projection diagnostics: excluded counts include withheld data.
  // Daily scalar summaries keep provider context bounded and exclude raw text/IDs.
  const buckets = new Map<
    string,
    {
      samples: number;
      usable: number;
      failures: number;
      durationSum: number;
      durationCount: number;
      requests: number;
      errors: number;
      missingValues: number;
    }
  >();
  for (const sample of projected.samples) {
    const day = sample.observedAt.slice(0, 10),
      b = buckets.get(day) ?? {
        samples: 0,
        usable: 0,
        failures: 0,
        durationSum: 0,
        durationCount: 0,
        requests: 0,
        errors: 0,
        missingValues: 0,
      };
    b.samples++;
    if (sample.kind === "signal") b.usable++;
    else if (sample.usable) {
      b.usable++;
      if (sample.kind === "probe") {
        if (sample.success === null || sample.durationMs === null)
          b.missingValues++;
        if (sample.success === false) b.failures++;
        if (sample.durationMs !== null) {
          b.durationSum += sample.durationMs;
          b.durationCount++;
        }
      } else {
        if (sample.requests === null || sample.errors === null)
          b.missingValues++;
        b.requests += sample.requests ?? 0;
        b.errors += sample.errors ?? 0;
      }
    }
    buckets.set(day, b);
  }
  if (
    [...buckets.values()].some((b) =>
      Object.values(b).some(
        (n) => !Number.isFinite(n) || n > Number.MAX_SAFE_INTEGER,
      ),
    )
  )
    throw new Error("Training totals exceed numeric bounds");
  const context = {
    cutoffAt: projected.cutoffAt,
    coverageVerified: false,
    seed: {
      selector: { kind: rule.selector.kind, field: rule.selector.field },
      stepSeconds: rule.stepSeconds,
      collectionDelaySeconds: rule.collectionDelaySeconds ?? 0,
      parameters: parameters.parse(
        Object.fromEntries(parameterKeys.map((k) => [k, rule[k]])),
      ),
    },
    days: [...buckets]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, x]) => ({ date, ...x })),
    reviewedLabels: projected.labels.map((l) => ({
      startedAt: l.startedAt,
      endedAt: l.endedAt,
      outcome: l.outcome,
    })),
  };
  const serialized = JSON.stringify(context);
  if (Buffer.byteLength(serialized) > 131072 || buckets.size > 33)
    throw new Error("Training context exceeds budget");
  if (!projected.samples.length && !projected.labels.length)
    throw new Error("No training evidence available");
  return ruleCandidateInputSchema.parse({
    version: 1,
    sourceSnapshotId: s.snapshotId,
    sourceInputHash: source.inputHash,
    seedVersion: s.version,
    profileId,
    candidateId,
    context,
  });
}
