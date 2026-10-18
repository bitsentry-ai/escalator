import { PostgresRuleProposalRepository } from "./rule-proposal.repository.js";
import { RuleProposalEvaluation } from "@bitsentry-escalator/features/application";
import type { Pool, PoolClient } from "pg";
import {
  opaqueIdSchema,
  workspaceIdSchema,
  ruleProposalClaimSchema,
  type WorkspaceId,
  type RuleProposalClaim,
} from "@bitsentry-escalator/features/contracts";
import {
  decodeRuleProposal,
  encodeRuleProposal,
  RuleProposalLeaseFence,
  transitionRuleProposalClaim,
  ruleProposalClaimDisposition,
  type RuleProposalClaims,
  type FoundationTransaction,
} from "@bitsentry-escalator/features/application";
import { PostgresFoundationRepository } from "./foundation.repository.js";
import { withBoundedRulePool } from "./bounded-rule-pool.js";
type Job = {
  state: string;
  kind: string;
  payload: unknown;
  attempt_count: number;
  due_at: Date;
  lease_token: string | null;
  lease_expires_at: Date | null;
};
function validJob(job: Job, id: string) {
  if (
    job.kind !== "rules.propose" ||
    !job.payload ||
    typeof job.payload !== "object" ||
    Array.isArray(job.payload) ||
    Object.keys(job.payload).length !== 1 ||
    !("proposalId" in job.payload) ||
    job.payload.proposalId !== id
  )
    throw new Error("Proposal generation job binding mismatch");
}
export class PostgresRuleProposalClaims implements RuleProposalClaims {
  constructor(private readonly pool: Pool) {}
  private within<T>(
    scope: WorkspaceId,
    work: (
      db: PoolClient,
      base: FoundationTransaction,
      fence: RuleProposalLeaseFence,
    ) => Promise<T>,
  ): Promise<T> {
    const fence = new RuleProposalLeaseFence();
    return withBoundedRulePool(
      this.pool,
      (pool) =>
        new PostgresFoundationRepository(pool).withConnection(
          scope,
          async (base, db) => {
            await db.query("SET LOCAL statement_timeout = '5s'");
            await db.query("SET LOCAL lock_timeout = '1s'");
            return work(db, base, fence);
          },
        ),
      10000,
      () => performance.now(),
      () => fence.assertLive(),
    );
  }
  async claim(
    input: Parameters<RuleProposalClaims["claim"]>[0],
  ): Promise<RuleProposalClaim | undefined> {
    const scope = workspaceIdSchema.parse(input.workspaceId),
      runtime = opaqueIdSchema.parse(input.runtimeId),
      token = opaqueIdSchema.parse(input.token);
    await new RuleProposalEvaluation(
      new PostgresRuleProposalRepository(this.pool),
    ).recover(scope);
    return this.within(scope, async (db, base, fence) => {
      // Lock proposal before its job, including reclamation and terminal cleanup.
      const candidates = await db.query<{ data: unknown }>(
        `SELECT p.data FROM escalator_rule_proposal p
    LEFT JOIN escalator_job j ON j.workspace_id=p.workspace_id AND j.id=p.id
    WHERE p.workspace_id=$1 AND p.status IN ('queued','generating') AND
    (p.expires_at<=clock_timestamp() OR j.id IS NULL OR j.state IN ('completed','failed','cancelled') OR
     (j.state='pending' AND j.due_at<=clock_timestamp()) OR (j.state='running' AND j.lease_expires_at<=clock_timestamp()))
    ORDER BY p.created_at,p.id FOR UPDATE OF p SKIP LOCKED LIMIT 1`,
        [scope],
      );
      if (!candidates.rows[0]) return undefined;
      const before = decodeRuleProposal(scope, candidates.rows[0].data);
      const jobs = await db.query<Job>(
        "SELECT state,kind,payload,attempt_count,due_at,lease_token,lease_expires_at FROM escalator_job WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [scope, before.id],
      );
      const job = jobs.rows[0];
      if (job) validJob(job, before.id);
      const clock = await db.query<{ now: Date }>(
          "SELECT clock_timestamp() AS now",
        ),
        now = clock.rows[0].now;
      const disposition = ruleProposalClaimDisposition(
        before,
        job
          ? {
              state: job.state,
              attempt: job.attempt_count,
              dueAt: job.due_at.toISOString(),
              leaseExpiresAt: job.lease_expires_at?.toISOString() ?? null,
            }
          : undefined,
        now.toISOString(),
      );
      if (disposition === "busy") return undefined;
      const failed = disposition !== "claimed";
      const next = transitionRuleProposalClaim(
        before,
        now.toISOString(),
        disposition,
      );
      if (!failed && (!job || job.lease_token === token))
        throw new Error("Reclaim requires a fresh token");
      const saved = await db.query(
        `UPDATE escalator_rule_proposal SET revision=$3::bigint,status=$4,runtime_id=$5,updated_at=$6::timestamptz,data=$7::jsonb
    WHERE workspace_id=$1 AND id=$2 AND revision=$8::bigint RETURNING id`,
        [
          scope,
          before.id,
          next.row.revision,
          next.row.status,
          failed ? null : runtime,
          next.row.updatedAt,
          encodeRuleProposal(scope, next.row),
          before.revision,
        ],
      );
      if (saved.rowCount !== 1)
        throw new Error("Proposal claim revision conflict");
      if (failed) {
        if (job && ["pending", "running"].includes(job.state))
          await db.query(
            `UPDATE escalator_job SET state='failed',lease_token=NULL,lease_expires_at=NULL,completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 RETURNING id`,
            [scope, before.id],
          );
        await base.audit.append(next.audit);
        return undefined;
      }
      const started = fence.start();
      const result = await db.query<{
        attempt_count: number;
        lease_expires_at: Date;
        remaining: number;
      }>(
        `UPDATE escalator_job SET state='running',lease_token=$3,
    lease_expires_at=LEAST($4::timestamptz,clock_timestamp()+interval '60 seconds'),attempt_count=attempt_count+1,updated_at=clock_timestamp()
    WHERE workspace_id=$1 AND id=$2 AND attempt_count<3 AND $4::timestamptz>clock_timestamp()
    AND ((state='pending' AND due_at<=clock_timestamp()) OR (state='running' AND lease_expires_at<=clock_timestamp()))
    RETURNING attempt_count,lease_expires_at,extract(epoch FROM (lease_expires_at-clock_timestamp()))::double precision*1000 AS remaining`,
        [scope, before.id, token, before.expiresAt],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Proposal job became unavailable");
      fence.bind(started, row.remaining);
      const claim = ruleProposalClaimSchema.parse({
        workspaceId: scope,
        proposalId: before.id,
        runtimeId: runtime,
        token,
        attempt: row.attempt_count,
        leaseExpiresAt: row.lease_expires_at.toISOString(),
      });
      await base.audit.append(next.audit);
      return claim;
    });
  }
  heartbeat(raw: RuleProposalClaim): Promise<boolean> {
    const claim = ruleProposalClaimSchema.parse(raw);
    return this.within(claim.workspaceId, async (db, _base, fence) => {
      const proposals = await db.query<{
        data: unknown;
        runtime_id: string | null;
      }>(
        "SELECT data,runtime_id FROM escalator_rule_proposal WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [claim.workspaceId, claim.proposalId],
      );
      const entry = proposals.rows[0];
      if (!entry || entry.runtime_id !== claim.runtimeId) return false;
      const proposal = decodeRuleProposal(claim.workspaceId, entry.data);
      if (proposal.status !== "generating") return false;
      const jobs = await db.query<Job>(
        "SELECT state,kind,payload,attempt_count,due_at,lease_token,lease_expires_at FROM escalator_job WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [claim.workspaceId, claim.proposalId],
      );
      const job = jobs.rows[0];
      if (!job) return false;
      validJob(job, claim.proposalId);
      const started = fence.start();
      const result = await db.query<{ remaining: number }>(
        `UPDATE escalator_job SET lease_expires_at=LEAST($5::timestamptz,GREATEST(lease_expires_at,clock_timestamp()+interval '60 seconds')),updated_at=clock_timestamp()
    WHERE workspace_id=$1 AND id=$2 AND state='running' AND lease_token=$3 AND attempt_count=$4 AND lease_expires_at>clock_timestamp() AND $5::timestamptz>clock_timestamp()
    RETURNING extract(epoch FROM (lease_expires_at-clock_timestamp()))::double precision*1000 AS remaining`,
        [
          claim.workspaceId,
          claim.proposalId,
          claim.token,
          claim.attempt,
          proposal.expiresAt,
        ],
      );
      if (!result.rows[0]) return false;
      fence.bind(started, result.rows[0].remaining);
      return true;
    });
  }
}
