import { createHash } from "node:crypto";
import { z } from "zod";
import {
  detectionRuleVersionSchema,
  type DetectionRuleVersion,
} from "../../contracts/rule-state.js";
import {
  ruleBacktestRecordSchema,
  type RuleBacktestRecord,
} from "../../contracts/backtest-record.js";
import {
  ruleReplayRunSchema,
  storedRuleReplaySnapshotSchema,
  type RuleReplayRun,
  type StoredRuleReplaySnapshot,
} from "../../contracts/replay-run.js";
import {
  ruleRetainedEvidenceSchema,
  type RuleRetainedEvidence,
} from "../../contracts/rule-replay.js";
import {
  rulePolicyFactSchema,
  type RulePolicyFact,
} from "../../contracts/rule-policy.js";
import {
  incidentLabelSchema,
  type IncidentLabel,
} from "../../contracts/rule-label.js";
import { ruleMeasurementHashSchema } from "../../contracts/rule-history.js";
import { utcTimestampSchema } from "../../contracts/entities.js";
import { compareUtcTimestamps } from "../../contracts/timestamps.js";
import { PersistenceError } from "../ports/persistence.js";
import { resolveRulePolicy } from "./policy.js";
import type { RuleCatalogStore } from "./activation-ports.js";
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Shared with report finalization; preserve the persisted label projection. */
export function ruleReviewedLabelHash(raw: readonly IncidentLabel[]) {
  const labels = z.array(incidentLabelSchema).max(1000).parse(raw);
  return hash(
    [...labels]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((l) => ({
        id: l.id,
        revision: l.revision,
        reviewedAt: l.reviewedAt,
        outcome: l.outcome,
        startedAt: l.startedAt,
        endedAt: l.endedAt,
      })),
  );
}
function historicalCoverage(input: RuleRetainedEvidence) {
  return hash({
    history: { ...input.history, snapshotAt: null, visibleAt: null },
    policyFacts: input.policyFacts,
    policyComplete: input.policyComplete,
  });
}
export interface RuleReviewReportInput {
  run: RuleReplayRun;
  snapshot: StoredRuleReplaySnapshot;
  report: RuleBacktestRecord;
  fresh: RuleRetainedEvidence;
  labels: readonly IncidentLabel[];
}
/** Host must hold current responder, source/stream and policy locks through
 * commit. Selected report/capture reads use that same physical transaction.
 * AI provenance/full/held-out seals are an additional check by the caller. */
export function buildRuleReviewEvidence(
  rawVersion: DetectionRuleVersion,
  rawNow: string,
  rawMeasurementHash: string,
  rawFacts: readonly RulePolicyFact[],
  selected: RuleReviewReportInput | null,
): Awaited<ReturnType<RuleCatalogStore["evidence"]>> {
  const version = detectionRuleVersionSchema.parse(rawVersion),
    d = version.definition,
    now = utcTimestampSchema.parse(rawNow),
    measurementHash = ruleMeasurementHashSchema.parse(rawMeasurementHash);
  const facts = z.array(rulePolicyFactSchema).max(12).parse(rawFacts);
  if (facts.some((f) => compareUtcTimestamps(f.recordedAt, now) > 0))
    throw new Error("Future policy fact in current review");
  const policy = resolveRulePolicy(d, now, facts);
  const fingerprint = {
    versionHash: hash(version),
    measurementHash,
    coverageHash: hash({ history: "not_selected" }),
    policyHash: hash(
      [...facts].sort((a, b) =>
        BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0,
      ),
    ),
    labelHash: ruleReviewedLabelHash([]),
    reportHash: null as string | null,
  };
  if (!selected)
    return {
      fingerprint,
      report: null,
      measurementHash,
      policyKnown: policy.known,
      policyEnabled: policy.enabled && policy.pagingEnabled !== false,
    };
  const run = ruleReplayRunSchema.parse(selected.run),
    stored = storedRuleReplaySnapshotSchema.parse(selected.snapshot),
    record = ruleBacktestRecordSchema.parse(selected.report),
    snapshot = stored.snapshot,
    report = record.report;
  if (
    run.workspaceId !== d.workspaceId ||
    stored.workspaceId !== d.workspaceId ||
    record.workspaceId !== d.workspaceId ||
    run.snapshotId !== snapshot.snapshotId ||
    record.snapshotId !== snapshot.snapshotId ||
    record.runId !== run.id
  )
    throw new PersistenceError("scope_violation");
  if (
    run.status !== "completed" ||
    run.inputHash !== stored.inputHash ||
    record.inputHash !== stored.inputHash ||
    hash(snapshot) !== stored.inputHash ||
    JSON.stringify(snapshot.version) !== JSON.stringify(version) ||
    JSON.stringify(report.rule) !== JSON.stringify(version)
  )
    throw new Error(
      "Review requires an intact completed report for this version",
    );
  const count =
    Math.floor(
      (Date.parse(snapshot.lastDecisionAt) -
        Date.parse(snapshot.firstDecisionAt)) /
        (d.stepSeconds * 1000),
    ) + 1;
  if (
    run.decisionCount !== count ||
    report.coverage.totalDecisions !== count ||
    report.range.firstDecisionAt !== snapshot.firstDecisionAt ||
    report.range.lastDecisionAt !== snapshot.lastDecisionAt ||
    JSON.stringify(report.evaluation) !== JSON.stringify(snapshot.evaluation) ||
    JSON.stringify(report.candidateEvaluation) !==
      JSON.stringify(snapshot.candidateEvaluation) ||
    compareUtcTimestamps(record.createdAt, run.updatedAt) < 0 ||
    compareUtcTimestamps(record.createdAt, now) > 0 ||
    compareUtcTimestamps(snapshot.snapshotAt, now) > 0
  )
    throw new Error("Review report completion does not match its capture");
  if (snapshot.evaluation)
    throw new Error(
      "Select a full backtest; held-out evaluation is supplementary",
    );
  if (Buffer.byteLength(JSON.stringify(selected.fresh)) > 16 * 1024 * 1024)
    throw new Error("Current review evidence exceeds storage bound");
  const before = snapshot.retained,
    fresh = ruleRetainedEvidenceSchema.parse(selected.fresh);
  if (
    !before ||
    !before.history.complete ||
    !fresh.history.complete ||
    !before.policyComplete ||
    !fresh.policyComplete
  )
    throw new Error("Review requires an untruncated retained capture");
  const h = fresh.history;
  if (
    h.workspaceId !== d.workspaceId ||
    h.serviceId !== d.serviceId ||
    h.environmentId !== d.environmentId ||
    h.kind !== d.selector.kind ||
    h.streamId !== d.selector.streamId ||
    h.startAt !== before.history.startAt ||
    h.endAt !== before.history.endAt ||
    h.visibleAt !== now
  )
    throw new PersistenceError("scope_violation");
  if (
    fresh.measurementHash !== measurementHash ||
    before.measurementHash !== measurementHash ||
    historicalCoverage(before) !== historicalCoverage(fresh)
  )
    throw new Error("Coverage or measurement changed; run a fresh backtest");
  const labels = z.array(incidentLabelSchema).max(1000).parse(selected.labels);
  if (
    new Set(labels.map((l) => l.id)).size !== labels.length ||
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
  if (
    labels.some(
      (l) =>
        l.status !== "reviewed" ||
        !l.reviewedAt ||
        compareUtcTimestamps(l.reviewedAt, now) > 0 ||
        compareUtcTimestamps(l.endedAt, snapshot.firstDecisionAt) <= 0 ||
        compareUtcTimestamps(l.startedAt, snapshot.lastDecisionAt) > 0,
    )
  )
    throw new Error("Invalid current review labels");
  const labelHash = ruleReviewedLabelHash(labels);
  if (record.labelHash !== labelHash)
    throw new Error("Reviewed labels changed; run a fresh backtest");
  return {
    fingerprint: {
      ...fingerprint,
      coverageHash: historicalCoverage(fresh),
      labelHash,
      reportHash: hash(record),
    },
    report: record,
    measurementHash,
    policyKnown: policy.known,
    policyEnabled: policy.enabled && policy.pagingEnabled !== false,
  };
}
