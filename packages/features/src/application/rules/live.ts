import {
  ruleLiveRecordSchema,
  ruleEvaluationPayloadSchema,
  ruleDecisionPolicySchema,
  utcTimestampSchema,
  policyDefinition,
  type WorkspaceId,
  type RuleLiveRecord,
} from "../../contracts/index.js";
import { advanceRuleDecision } from "../../domain/rules/advance.js";
import { readRuleHistoryWindow } from "./history-reader.js";
import type { RuleLiveRepository, RuleLiveTransaction } from "./live-ports.js";
import type { WorkLease, WorkResult } from "../jobs/ports.js";
import { pagingWorkId } from "../paging/work-ids.js";
import { openPageInTransaction } from "../paging/create-page.js";
import { resolvePageInTransaction } from "../paging/resolve.js";
import { PersistenceError } from "../ports/persistence.js";
const actor = { kind: "system", component: "rules" } as const;
export function ruleEvaluationJobId(
  scope: WorkspaceId,
  ruleId: string,
  generation: number,
  dueAt: string,
) {
  return pagingWorkId(
    scope,
    "rule-evaluation",
    ruleId,
    String(generation),
    dueAt,
  );
}
export async function enqueueRuleEvaluation(
  tx: RuleLiveTransaction,
  row: RuleLiveRecord,
) {
  if (row.version.definition.workspaceId !== tx.workspaceId)
    throw new PersistenceError("scope_violation");
  if (
    row.jobId !==
    ruleEvaluationJobId(
      tx.workspaceId,
      row.version.id,
      row.generation,
      row.dueAt,
    )
  )
    throw new Error("Invalid rule job identity");
  await tx.work.enqueue("job", {
    id: row.jobId,
    kind: "rules.evaluate",
    idempotencyKey: row.jobId,
    dueAt: row.dueAt,
    payload: {
      ruleId: row.version.id,
      generation: row.generation,
      dueAt: row.dueAt,
    },
  });
}
/** Locks the rule row, then its open incident's page, before the work claim. */
async function lockRuleRow(tx: RuleLiveTransaction, ruleId: string) {
  const raw = await tx.rules.lock(ruleId);
  const row = raw ? ruleLiveRecordSchema.parse(raw) : undefined;
  if (
    row &&
    (row.version.id !== ruleId ||
      row.version.definition.workspaceId !== tx.workspaceId)
  )
    throw new PersistenceError("scope_violation");
  if (row?.incidentId)
    await tx.pages.lock(pagingWorkId(tx.workspaceId, "page", row.incidentId));
  return row;
}
function assertRuleClaim(
  claim: { workspaceId: string; queue: string; kind: string; id: string },
  payload: { ruleId: string; generation: number; dueAt: string },
  workspaceId: WorkspaceId,
  ruleId: string,
): void {
  if (
    claim.workspaceId !== workspaceId ||
    claim.queue !== "job" ||
    claim.kind !== "rules.evaluate" ||
    payload.ruleId !== ruleId ||
    claim.id !==
      ruleEvaluationJobId(
        workspaceId,
        payload.ruleId,
        payload.generation,
        payload.dueAt,
      )
  )
    throw new Error("Invalid rule evaluation claim");
}
/** Unknown policy history never suppresses; an active rule also needs paging enabled. */
function effectivelyEnabled(
  policy: { known: boolean; enabled: boolean; pagingEnabled?: boolean },
  mode: RuleLiveRecord["mode"],
): boolean {
  if (!policy.known) return true;
  return (
    policy.enabled && (mode === "shadow" || policy.pagingEnabled !== false)
  );
}
/** Opens the incident page of a newly opened episode under the service's enabled escalation policy. */
async function openRuleIncident(
  tx: RuleLiveTransaction,
  row: RuleLiveRecord,
  decisionAt: string,
): Promise<string> {
  const definition = row.version.definition;
  const binding = await tx.detection.binding(
    definition.serviceId,
    definition.environmentId,
  );
  const paging =
    binding?.enabled && binding.policyId
      ? await tx.configuration.policies.get(binding.policyId)
      : undefined;
  if (!paging?.enabled || paging.serviceId !== definition.serviceId)
    throw new Error("Rule paging policy is unavailable");
  const incidentId = pagingWorkId(
    tx.workspaceId,
    "rule-incident",
    row.version.id,
    String(row.generation),
    decisionAt,
  );
  await openPageInTransaction(
    tx,
    {
      incident: {
        id: incidentId,
        serviceId: definition.serviceId,
        environmentId: definition.environmentId,
        title: row.title,
        severity: definition.severity,
      },
      policy: policyDefinition(paging),
    },
    actor,
  );
  return incidentId;
}
/** No network I/O. Uses the replay transition function and existing atomic page
 * operations; a shadow evaluation never calls page or incident mutators. */
export class LiveRuleEvaluation {
  constructor(private readonly repository: RuleLiveRepository) {}
  process(lease: WorkLease): Promise<WorkResult> {
    const hint = ruleEvaluationPayloadSchema.parse(lease.payload);
    return this.repository.transaction(lease.workspaceId, async (tx) => {
      const row = await lockRuleRow(tx, hint.ruleId);
      const claim = await tx.work.lockClaim(lease);
      if (!claim) return { state: "completed" };
      const payload = ruleEvaluationPayloadSchema.parse(claim.payload);
      assertRuleClaim(claim, payload, tx.workspaceId, hint.ruleId);
      if (
        !row ||
        row.generation !== payload.generation ||
        row.dueAt !== payload.dueAt ||
        row.jobId !== claim.id
      )
        return { state: "completed" };
      const now = Date.parse(await tx.currentTime()),
        due = Date.parse(row.dueAt);
      if (now < due)
        return { state: "wait", delayMs: Math.min(3600000, due - now) };
      const definition = row.version.definition,
        step = definition.stepSeconds * 1000;
      // An outage does not prove consecutive persistence during the missed ticks.
      const decisionAt = new Date(Math.floor(now / step) * step).toISOString();
      const window = await readRuleHistoryWindow(
        {
          snapshot: async (scope, query) => {
            if (scope !== tx.workspaceId)
              throw new PersistenceError("scope_violation");
            return tx.rules.history(query);
          },
        },
        definition,
        decisionAt,
        row.measurementHash,
      );
      const policy = ruleDecisionPolicySchema.parse(
        await tx.rules.policy(row, decisionAt),
      );
      if (!policy.known) window.coverage = "unknown";
      const transition = advanceRuleDecision(row.version, row.state, {
        window,
        enabled: effectivelyEnabled(policy, row.mode),
        maintenance: policy.known && policy.maintenance,
      });
      if (transition.status === "duplicate" || transition.status === "stale")
        throw new Error("Rule schedule did not advance its state");
      let incidentId = row.incidentId;
      if (row.mode === "active" && transition.action === "opened") {
        if (incidentId !== null)
          throw new Error("Rule episode already has an incident");
        incidentId = await openRuleIncident(tx, row, decisionAt);
      }
      if (
        row.mode === "active" &&
        transition.action === "recovered" &&
        incidentId !== null
      ) {
        await resolvePageInTransaction(tx, incidentId, actor);
        incidentId = null;
      }
      const nextDueAt = new Date(Date.parse(decisionAt) + step).toISOString();
      const next = ruleLiveRecordSchema.parse({
        ...row,
        revision: row.revision + 1,
        state: transition.state,
        incidentId,
        dueAt: nextDueAt,
        jobId: ruleEvaluationJobId(
          tx.workspaceId,
          row.version.id,
          row.generation,
          nextDueAt,
        ),
      });
      await tx.rules.decision(row, transition);
      if (!(await tx.rules.save(next, row.revision)))
        throw new Error("Locked rule revision changed");
      await enqueueRuleEvaluation(tx, next);
      await tx.audit.append({
        id: pagingWorkId(
          tx.workspaceId,
          "rule-decision",
          row.version.id,
          String(row.generation),
          decisionAt,
        ),
        workspaceId: tx.workspaceId,
        actor,
        action: "rule.evaluated",
        subjectType: "rule",
        subjectId: row.version.id,
        recordedAt: tx.now,
        metadata: {
          generation: row.generation,
          revision: row.version.revision,
          mode: row.mode,
          decisionAt,
          status: transition.status,
          action: transition.action,
          reason: transition.verdict?.reason ?? null,
          incidentId,
          skippedDecisions: Math.max(
            0,
            Math.floor((Date.parse(decisionAt) - due) / step),
          ),
        },
      });
      if (
        Date.parse(await tx.currentTime()) >=
        Date.parse(utcTimestampSchema.parse(claim.leaseExpiresAt))
      )
        throw new Error("Rule lease expired before commit");
      return { state: "completed" };
    });
  }
}
