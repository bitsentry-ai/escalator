import { RuleRequestError } from "./request-error.js";
import { createHash } from "node:crypto";
import { hasCapability, type Actor } from "../../contracts/identity.js";
import {
  detectionRuleVersionSchema,
  type DetectionRuleVersion,
} from "../../contracts/rule-state.js";
import { ruleReplaySnapshotSchema } from "../../contracts/rule-replay.js";
import {
  storedRuleReplaySnapshotSchema,
  ruleReplayRunSchema,
  type StoredRuleReplaySnapshot,
  type RuleReplayRun,
} from "../../contracts/replay-run.js";
import { ruleEvaluationSealSchema } from "../../contracts/rule-evaluation.js";
import { compareUtcTimestamps } from "../../contracts/timestamps.js";
import { PersistenceError } from "../ports/persistence.js";
import { pagingWorkId } from "../paging/work-ids.js";
import type { RuleReplayCaptureRepository } from "./replay-capture.js";
import { planRuleTuning } from "./tuning.js";
import { enqueueRuleReplay } from "./replay-job.js";
import { expectDefined } from "../../contracts/expect-defined.js";
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Internal derivation from a server-loaded immutable capture. Never accept a
 * caller's samples, cutoffs, coverage or historical policy as trusted evidence. */
export function deriveHeldOutReplay(
  raw: StoredRuleReplaySnapshot,
  candidateRaw: DetectionRuleVersion,
): StoredRuleReplaySnapshot {
  const source = storedRuleReplaySnapshotSchema.parse(raw),
    s = source.snapshot,
    version = detectionRuleVersionSchema.parse(candidateRaw),
    d = version.definition,
    original = s.version.definition;
  if (hash(s) !== source.inputHash)
    throw new Error("Source snapshot integrity mismatch");
  if (s.evaluation || s.candidateEvaluation || !s.retained)
    throw new Error(
      "Held-out evaluation requires an original retained capture",
    );
  if (
    d.workspaceId !== source.workspaceId ||
    d.serviceId !== original.serviceId ||
    d.environmentId !== original.environmentId ||
    d.selector.kind !== original.selector.kind ||
    d.selector.streamId !== original.selector.streamId
  )
    throw new PersistenceError("scope_violation");
  if (
    version.revision !== 1 ||
    d.stepSeconds !== original.stepSeconds ||
    (d.collectionDelaySeconds ?? 0) !== (original.collectionDelaySeconds ?? 0)
  )
    throw new Error(
      "Candidate must use the captured cadence and collection delay",
    );
  const plan = planRuleTuning(s);
  if (!plan.heldOut)
    throw new Error("Insufficient history for held-out evaluation");
  const range = plan.heldOut,
    delay = (d.collectionDelaySeconds ?? 0) * 1000;
  const startAt = new Date(
      Date.parse(range.firstDecisionAt) - delay - d.windowSeconds * 1000,
    ).toISOString(),
    endAt = new Date(Date.parse(range.lastDecisionAt) - delay).toISOString();
  if (
    compareUtcTimestamps(startAt, s.retained.history.startAt) < 0 ||
    compareUtcTimestamps(endAt, s.retained.history.endAt) > 0
  )
    throw new Error("Candidate exceeds captured history");
  const evaluation = ruleEvaluationSealSchema.parse({
    kind: "held_out",
    strategy: plan.strategy,
    sourceSnapshotId: s.snapshotId,
    sourceInputHash: source.inputHash,
    candidateHash: hash(version),
    trainingCutoffAt: plan.training.lastDecisionAt,
    ...range,
    gapSeconds: plan.gapSeconds,
  });
  const snapshot = ruleReplaySnapshotSchema.parse({
    ...s,
    ...range,
    version,
    evaluation,
    snapshotId: pagingWorkId(
      source.workspaceId,
      "rule-held-out-snapshot",
      s.snapshotId,
    ),
    retained: {
      history: { ...s.retained.history, startAt, endAt },
      measurementHash: s.retained.measurementHash,
      policyFacts: s.retained.policyFacts,
      policyComplete: s.retained.policyComplete,
    },
  });
  return storedRuleReplaySnapshotSchema.parse({
    workspaceId: source.workspaceId,
    snapshot,
    inputHash: hash(snapshot),
  });
}
/** One immutable candidate per source capture. Unique snapshot/run keys fence
 * racing submissions; a caught insert failure poisons the entire transaction. */
export class EvaluateHeldOutRule {
  constructor(private readonly repository: RuleReplayCaptureRepository) {}
  create(
    actor: Actor,
    sourceSnapshotId: string,
    candidate: DetectionRuleVersion,
  ): Promise<RuleReplayRun> {
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      if (tx.workspaceId !== actor.workspaceId)
        throw new PersistenceError("scope_violation");
      if (!hasCapability(actor.role, "rule:propose"))
        throw new RuleRequestError("FORBIDDEN", "Rule evaluation forbidden");
      const responder = await tx.responders.get(actor.responderId);
      if (
        !responder?.enabled ||
        responder.workspaceId !== tx.workspaceId ||
        responder.id !== actor.responderId ||
        responder.role !== actor.role
      )
        throw new RuleRequestError("FORBIDDEN", "Rule evaluation forbidden");
      const source = await tx.replay.snapshot(sourceSnapshotId);
      if (!source) throw new PersistenceError("not_found");
      if (
        source.workspaceId !== tx.workspaceId ||
        source.snapshot.snapshotId !== sourceSnapshotId
      )
        throw new PersistenceError("scope_violation");
      const stored = deriveHeldOutReplay(source, candidate),
        id = pagingWorkId(
          tx.workspaceId,
          "rule-held-out-run",
          sourceSnapshotId,
        );
      const existing = await tx.replay.lock(id);
      if (existing) {
        if (
          existing.workspaceId !== tx.workspaceId ||
          existing.snapshotId !== stored.snapshot.snapshotId ||
          existing.inputHash !== stored.inputHash
        )
          throw new Error(
            "A different candidate is already sealed for this capture",
          );
        return ruleReplayRunSchema.parse(existing);
      }
      await tx.capture.reserve();
      const now = await tx.replay.currentTime();
      const run = ruleReplayRunSchema.parse({
        id,
        workspaceId: tx.workspaceId,
        snapshotId: stored.snapshot.snapshotId,
        inputHash: stored.inputHash,
        revision: 1,
        status: "queued",
        nextBatch: 0,
        cursor: null,
        decisionCount: 0,
        createdAt: now,
        updatedAt: now,
      });
      await tx.capture.insert(stored, run);
      await enqueueRuleReplay(tx, run);
      await tx.audit.append({
        id: pagingWorkId(tx.workspaceId, "rule-held-out-requested", id),
        workspaceId: tx.workspaceId,
        actor: { kind: "responder", responderId: actor.responderId },
        action: "rule.held_out_requested",
        subjectType: "rule-replay",
        subjectId: id,
        recordedAt: now,
        metadata: {
          sourceSnapshotId,
          sourceInputHash: source.inputHash,
          candidateHash: expectDefined(
            stored.snapshot.evaluation,
            "held-out evaluation",
          ).candidateHash,
          inputHash: stored.inputHash,
        },
      });
      return run;
    });
  }
}
