import { z } from "zod";
import {
  ruleReplaySnapshotSchema,
  type RuleReplaySnapshot,
} from "../../contracts/rule-replay.js";
import {
  incidentLabelSchema,
  type IncidentLabel,
} from "../../contracts/rule-label.js";
import type {
  RuleTuningPlan,
  RuleTrainingEvidence,
} from "../../contracts/rule-tuning.js";
import { compareUtcTimestamps } from "../../contracts/timestamps.js";
import { ruleSampleTime } from "../../domain/rules/time.js";
import { PersistenceError } from "../ports/persistence.js";
const day = 86400000,
  gapSeconds = 172800 as const;
/** Split depends only on the captured interval and grid, never candidate success
 * or reviewed outcomes. Two days separate training from evaluation, covering
 * the maximum permitted lookback and collection delay; require two held-out days. */
export function planRuleTuning(raw: RuleReplaySnapshot): RuleTuningPlan {
  const s = ruleReplaySnapshotSchema.parse(raw),
    step = s.version.definition.stepSeconds * 1000;
  const first = Date.parse(s.firstDecisionAt),
    last = Date.parse(s.lastDecisionAt),
    count = (last - first) / step + 1;
  const trainingCount = Math.floor(count * 0.8),
    trainingLast = first + (trainingCount - 1) * step;
  const heldOutFirst =
    Math.ceil((trainingLast + gapSeconds * 1000 + step) / step) * step;
  const split =
    count * step >= 14 * day && last - heldOutFirst + step >= 2 * day;
  return {
    version: 1,
    strategy: "temporal-80-20-with-gap",
    status: split ? "held_out" : "insufficient_span",
    training: {
      firstDecisionAt: s.firstDecisionAt,
      lastDecisionAt: split
        ? new Date(trainingLast).toISOString()
        : s.lastDecisionAt,
    },
    heldOut: split
      ? {
          firstDecisionAt: new Date(heldOutFirst).toISOString(),
          lastDecisionAt: s.lastDecisionAt,
        }
      : null,
    gapSeconds,
  };
}
/** Recompute the fixed plan rather than trusting request-supplied cutoffs.
 * Retained comparisons, policy aggregates, report scores and current configuration
 * are intentionally absent. Null original availability cannot enter tuning. */
export function trainingRuleEvidence(
  raw: RuleReplaySnapshot,
  rawLabels: readonly IncidentLabel[],
): RuleTrainingEvidence {
  const s = ruleReplaySnapshotSchema.parse(raw),
    plan = planRuleTuning(s),
    cutoff = plan.training.lastDecisionAt,
    d = s.version.definition;
  const labels = z.array(incidentLabelSchema).max(1000).parse(rawLabels);
  if (
    labels.some(
      (l) =>
        l.workspaceId !== d.workspaceId ||
        l.serviceId !== d.serviceId ||
        l.environmentId !== d.environmentId ||
        l.stream.kind !== d.selector.kind ||
        l.stream.id !== d.selector.streamId,
    )
  )
    throw new PersistenceError("scope_violation");
  const configurations =
    s.retained?.history.configurations.filter(
      (c) =>
        c.recordedAt !== null &&
        c.effectiveAt !== null &&
        compareUtcTimestamps(c.recordedAt, cutoff) <= 0 &&
        compareUtcTimestamps(c.effectiveAt, cutoff) <= 0 &&
        c.measurementHash === s.retained!.measurementHash,
    ) ?? [];
  const compatible = new Set(configurations.map((c) => c.version));
  const receipts =
    s.retained?.history.receipts
      .filter(
        (r) =>
          r.sample.kind === "signal" ||
          (r.version !== null && compatible.has(r.version)),
      )
      .map((r) => r.sample) ?? s.samples;
  const originalCount = s.retained?.history.receipts.length ?? s.samples.length;
  const samples = receipts.filter(
    (sample) =>
      sample.receivedAt !== null &&
      (!("slotAt" in sample) ||
        sample.slotAt == null ||
        compareUtcTimestamps(sample.slotAt, cutoff) <= 0) &&
      compareUtcTimestamps(sample.receivedAt, cutoff) <= 0 &&
      compareUtcTimestamps(sample.observedAt, cutoff) <= 0 &&
      ruleSampleTime(d, sample) <= Date.parse(cutoff),
  );
  const selected = labels.filter(
    (l) =>
      l.status === "reviewed" &&
      l.reviewedAt !== null &&
      compareUtcTimestamps(l.reviewedAt, cutoff) <= 0 &&
      compareUtcTimestamps(l.endedAt, cutoff) <= 0 &&
      compareUtcTimestamps(l.endedAt, plan.training.firstDecisionAt) > 0,
  );
  return {
    plan,
    cutoffAt: cutoff,
    coverageVerified: false,
    samples: structuredClone(samples),
    labels: structuredClone(selected),
    excludedSamples: originalCount - samples.length,
    excludedLabels: labels.length - selected.length,
  };
}
