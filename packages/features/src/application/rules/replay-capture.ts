import { RuleRequestError } from "./request-error.js";
import { createHash } from "node:crypto";
import {
  hasCapability,
  type Actor,
  type WorkspaceId,
} from "../../contracts/identity.js";
import {
  detectionRuleVersionSchema,
  type DetectionRuleVersion,
} from "../../contracts/rule-state.js";
import {
  ruleReplaySnapshotSchema,
  type RuleReplaySnapshot,
  type RuleRetainedEvidence,
} from "../../contracts/rule-replay.js";
import {
  ruleReplayRunSchema,
  storedRuleReplaySnapshotSchema,
  type StoredRuleReplaySnapshot,
  type RuleReplayRun,
} from "../../contracts/replay-run.js";
import { PersistenceError } from "../ports/persistence.js";
import type { RuleReplayTransaction } from "./replay-ports.js";
import { enqueueRuleReplay } from "./replay-job.js";
export interface RuleReplayCaptureStore {
  /** Serialize the per-workspace active-run capacity check until commit. */
  reserve(): Promise<void>;
  /** One bounded SQL statement, exact receipt cutoff, scalar-only projection. */
  evidence(
    version: DetectionRuleVersion,
    range: { startAt: string; endAt: string; visibleAt: string },
  ): Promise<RuleRetainedEvidence>;
  insert(snapshot: StoredRuleReplaySnapshot, run: RuleReplayRun): Promise<void>;
}
export interface RuleReplayCaptureTransaction extends RuleReplayTransaction {
  capture: RuleReplayCaptureStore;
}
export interface RuleReplayCaptureRepository {
  transaction<T>(
    scope: WorkspaceId,
    work: (tx: RuleReplayCaptureTransaction) => Promise<T>,
  ): Promise<T>;
}
/** Capture is authorized separately from execution. No request-supplied receipt,
 * policy, coverage or hash is accepted as trusted historical evidence. */
export class CaptureRuleReplay {
  constructor(
    private readonly repository: RuleReplayCaptureRepository,
    private readonly newId: () => string,
  ) {}
  create(
    actor: Actor,
    rawVersion: DetectionRuleVersion,
    range: Pick<RuleReplaySnapshot, "firstDecisionAt" | "lastDecisionAt">,
  ): Promise<RuleReplayRun> {
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      const version = detectionRuleVersionSchema.parse(rawVersion),
        rule = version.definition;
      if (
        actor.workspaceId !== tx.workspaceId ||
        rule.workspaceId !== tx.workspaceId
      )
        throw new PersistenceError("scope_violation");
      if (!hasCapability(actor.role, "rule:propose"))
        throw new RuleRequestError("FORBIDDEN", "Rule replay forbidden");
      const responder = await tx.responders.get(actor.responderId);
      if (
        !responder?.enabled ||
        responder.workspaceId !== tx.workspaceId ||
        responder.id !== actor.responderId ||
        responder.role !== actor.role
      )
        throw new RuleRequestError("FORBIDDEN", "Rule replay forbidden");
      const service = await tx.services.get(rule.serviceId),
        environment = await tx.environments.get(rule.environmentId);
      if (!service || !environment) throw new PersistenceError("not_found");
      if (
        service.workspaceId !== tx.workspaceId ||
        environment.workspaceId !== tx.workspaceId ||
        service.id !== rule.serviceId ||
        environment.id !== rule.environmentId
      )
        throw new PersistenceError("scope_violation");
      const now = await tx.replay.currentTime();
      const initial = ruleReplaySnapshotSchema.parse({
        snapshotId: this.newId(),
        snapshotAt: now,
        version,
        firstDecisionAt: range.firstDecisionAt,
        lastDecisionAt: range.lastDecisionAt,
        complete: false,
        samples: [],
        coverage: [],
        policies: [],
      });
      await tx.capture.reserve();
      const delay = (rule.collectionDelaySeconds ?? 0) * 1000;
      const retained = await tx.capture.evidence(version, {
        startAt: new Date(
          Date.parse(initial.firstDecisionAt) -
            delay -
            rule.windowSeconds * 1000,
        ).toISOString(),
        endAt: new Date(
          Date.parse(initial.lastDecisionAt) - delay,
        ).toISOString(),
        visibleAt: now,
      });
      const snapshot = ruleReplaySnapshotSchema.parse({
        ...initial,
        complete: retained.history.complete && retained.policyComplete,
        retained,
      });
      const inputHash = createHash("sha256")
        .update(JSON.stringify(snapshot))
        .digest("hex");
      const stored = storedRuleReplaySnapshotSchema.parse({
        workspaceId: tx.workspaceId,
        snapshot,
        inputHash,
      });
      const run = ruleReplayRunSchema.parse({
        id: this.newId(),
        workspaceId: tx.workspaceId,
        snapshotId: snapshot.snapshotId,
        inputHash,
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
        id: this.newId(),
        workspaceId: tx.workspaceId,
        actor: { kind: "responder", responderId: actor.responderId },
        action: "rule.replay_requested",
        subjectType: "rule-replay",
        subjectId: run.id,
        recordedAt: now,
        metadata: {
          snapshotId: snapshot.snapshotId,
          ruleId: version.id,
          ruleRevision: version.revision,
          inputHash,
          firstDecisionAt: initial.firstDecisionAt,
          lastDecisionAt: initial.lastDecisionAt,
          complete: snapshot.complete,
        },
      });
      return run;
    });
  }
}
