import type { PoolClient } from "pg";
import {
  ruleProposalClaimSchema,
  type WorkspaceId,
  type RuleProposal,
  type RuleProposalClaim,
} from "@bitsentry-escalator/features/contracts";
import {
  encodeRuleProposal,
  decodeRuleProposal,
  RuleProposalLeaseFence,
  ruleProposalGenerationJob,
  ruleProposalEvaluationJob,
  PersistenceError,
  type RuleProposalStore,
  type WorkWriter,
} from "@bitsentry-escalator/features/application";
import { postgresRuleLabelStore } from "./postgres-rule-labels.store.js";
import { postgresInvestigationSettingsStore } from "./postgres-investigation-settings.store.js";
/** Transaction-owned primitives. The repository must invoke assertClaimLive before
 * returning and fence.assertLive at COMMIT. Never expose this store outside that scope. */
export function postgresRuleProposalStore(
  db: PoolClient,
  scope: WorkspaceId,
  work: WorkWriter,
  fence: RuleProposalLeaseFence,
) {
  const locked = new Map<
    string,
    { row: RuleProposal; runtime: string | null }
  >();
  let claim: RuleProposalClaim | undefined;
  let released = false;
  async function assertClaimLive(): Promise<void> {
    fence.assertLive();
    if (!claim) return;
    const started = fence.start();
    const result = await db.query<{ remaining: number }>(
      released
        ? "SELECT extract(epoch FROM ($1::timestamptz-clock_timestamp()))::double precision*1000 AS remaining"
        : `SELECT extract(epoch FROM (LEAST(lease_expires_at,$1::timestamptz)-clock_timestamp()))::double precision*1000 AS remaining
         FROM escalator_job WHERE workspace_id=$2 AND id=$3 AND state='running' AND lease_token=$4`,
      released
        ? [claim.leaseExpiresAt]
        : [claim.leaseExpiresAt, scope, claim.proposalId, claim.token],
    );
    if (!result.rows[0]) throw new Error("Proposal claim changed");
    fence.bind(started, result.rows[0].remaining);
  }
  const store: RuleProposalStore = {
    async evaluatingIds() {
      const result = await db.query<{ id: string }>(
        "SELECT id FROM escalator_rule_proposal WHERE workspace_id=$1 AND status='evaluating' ORDER BY created_at,id LIMIT 3 FOR UPDATE SKIP LOCKED",
        [scope],
      );
      return result.rows.map((row) => row.id);
    },
    async workState(id) {
      const result = await db.query<{
        state: "pending" | "running" | "completed" | "failed" | "cancelled";
      }>("SELECT state FROM escalator_job WHERE workspace_id=$1 AND id=$2", [
        scope,
        id,
      ]);
      return result.rows[0]?.state;
    },
    async lock(id) {
      const result = await db.query<{
        data: unknown;
        runtime_id: string | null;
      }>(
        "SELECT data,runtime_id FROM escalator_rule_proposal WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [scope, id],
      );
      const record = result.rows[0];
      if (!record) return undefined;
      const row = decodeRuleProposal(scope, record.data);
      locked.set(id, { row, runtime: record.runtime_id });
      return structuredClone(row);
    },
    async currentTime() {
      const result = await db.query<{ now: Date }>(
        "SELECT clock_timestamp() AS now",
      );
      return result.rows[0].now.toISOString();
    },
    async insert(row) {
      const data = encodeRuleProposal(scope, row);
      const intent = ruleProposalGenerationJob(row);
      // Serialize only creation quotas. Other operations lock proposal then job.
      const parent = await db.query(
        "SELECT id FROM escalator_workspace WHERE id=$1 FOR UPDATE",
        [scope],
      );
      if (!parent.rowCount) throw new PersistenceError("not_found");
      const count = await db.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM (SELECT id FROM escalator_rule_proposal WHERE workspace_id=$1 AND status IN ('queued','generating','evaluating') LIMIT 3) pending",
        [scope],
      );
      if (count.rows[0].count >= 3)
        throw new Error("Proposal capacity exhausted");
      await db.query(
        `INSERT INTO escalator_rule_proposal(workspace_id,id,source_snapshot_id,source_input_hash,origin_label_id,requested_by,candidate_id,profile_id,profile_revision,revision,status,created_at,updated_at,expires_at,data)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::bigint,1,'queued',$10::timestamptz,$11::timestamptz,$12::timestamptz,$13::jsonb)`,
        [
          scope,
          row.id,
          row.sourceSnapshotId,
          row.sourceInputHash,
          row.originLabelId,
          row.requestedBy,
          row.candidateId,
          row.profileId,
          row.profileRevision,
          row.createdAt,
          row.updatedAt,
          row.expiresAt,
          data,
        ],
      );
      if ((await work.enqueue("job", intent)) !== "inserted")
        throw new Error("Proposal generation job already exists");
      locked.set(row.id, { row: structuredClone(row), runtime: null });
    },
    async save(row, expected) {
      const data = encodeRuleProposal(scope, row),
        before = locked.get(row.id);
      if (!before || before.row.revision !== expected)
        throw new Error("Proposal must be locked before saving");
      const result = await db.query(
        `UPDATE escalator_rule_proposal SET revision=$3::bigint,status=$4,updated_at=$5::timestamptz,data=$6::jsonb,
        runtime_id=CASE WHEN $4='generating' THEN runtime_id ELSE NULL END,
        full_report_run_id=CASE WHEN $4='ready' THEN $6::jsonb->>'fullRunId' ELSE NULL END,
        held_out_report_run_id=CASE WHEN $4='ready' THEN $6::jsonb->>'heldOutRunId' ELSE NULL END WHERE workspace_id=$1 AND id=$2 AND revision=$7::bigint AND ($4<>'ready' OR expires_at>clock_timestamp()) RETURNING id`,
        [
          scope,
          row.id,
          row.revision,
          row.status,
          row.updatedAt,
          data,
          expected,
        ],
      );
      if (result.rowCount !== 1) return false;
      locked.set(row.id, {
        row: structuredClone(row),
        runtime: row.status === "generating" ? before.runtime : null,
      });
      return true;
    },
    label: (id) => postgresRuleLabelStore(db, scope).get(id, false),
    async profile(id) {
      const settings = await postgresInvestigationSettingsStore(db, scope).get(
        id,
      );
      return settings?.enabled ? settings.profile : undefined;
    },
    async lockClaim(raw) {
      const hint = ruleProposalClaimSchema.parse(raw);
      if (hint.workspaceId !== scope)
        throw new PersistenceError("scope_violation");
      const entry = locked.get(hint.proposalId);
      if (
        !entry ||
        entry.row.status !== "generating" ||
        entry.runtime !== hint.runtimeId
      )
        return undefined;
      if (
        claim &&
        (claim.proposalId !== hint.proposalId || claim.token !== hint.token)
      )
        throw new Error("One proposal claim per transaction");
      const actual = await work.lockClaim({
        workspaceId: scope,
        queue: "job",
        id: hint.proposalId,
        kind: "rules.propose",
        payload: { proposalId: hint.proposalId },
        token: hint.token,
        attempt: hint.attempt,
        dueAt: entry.row.createdAt,
        leaseExpiresAt: hint.leaseExpiresAt,
      });
      if (!actual || actual.attempt !== hint.attempt) return undefined;
      if (
        actual.kind !== "rules.propose" ||
        actual.payload.proposalId !== hint.proposalId ||
        Object.keys(actual.payload).length !== 1
      )
        throw new Error("Invalid proposal generation job");
      claim = ruleProposalClaimSchema.parse({
        ...hint,
        attempt: actual.attempt,
        leaseExpiresAt: actual.leaseExpiresAt,
      });
      await assertClaimLive();
      return { ...claim };
    },
    async scheduleEvaluation(row) {
      const saved = locked.get(row.id)?.row;
      if (!saved || JSON.stringify(saved) !== JSON.stringify(row))
        throw new Error("Evaluation requires the saved proposal");
      if (
        (await work.enqueue("job", ruleProposalEvaluationJob(row))) !==
        "inserted"
      )
        throw new Error("Proposal evaluation job already exists");
    },
    async releaseClaim(id) {
      const row = locked.get(id)?.row;
      if (!row || !["evaluating", "failed", "cancelled"].includes(row.status))
        throw new Error("Invalid generation completion");
      if (released) throw new Error("Proposal claim already released");
      if (row.status === "cancelled" && !claim) {
        // Actor authorization is performed by the shared use case before cancellation.
        await work.cancel("job", [id]);
        released = true;
        return;
      }
      if (!claim || claim.proposalId !== id)
        throw new Error("Generation completion requires its live claim");
      await assertClaimLive();
      const state = row.status === "evaluating" ? "completed" : row.status;
      const result = await db.query(
        `UPDATE escalator_job SET state=$4,lease_token=NULL,lease_expires_at=NULL,completed_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE workspace_id=$1 AND id=$2 AND state='running' AND lease_token=$3 AND lease_expires_at>clock_timestamp() RETURNING id`,
        [scope, id, claim.token, state],
      );
      if (result.rowCount !== 1)
        throw new Error("Proposal generation claim expired");
      released = true;
    },
  };
  return { store, assertClaimLive };
}
