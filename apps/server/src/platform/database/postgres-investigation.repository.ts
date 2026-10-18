import { investigationTransaction } from "./investigation-transaction.js";
import type { Pool, PoolClient } from "pg";
import {
  investigationScopeSchema,
  investigationReportSchema,
  investigationEvidenceSchema,
  opaqueIdSchema,
  type WorkspaceId,
  type InvestigationScope,
} from "@bitsentry-escalator/features/contracts";
import {
  captureInvestigation,
  investigationIntentSchema,
  investigationClaimSchema,
  sameInvestigationClaim,
  sameInvestigationConfiguration,
  validateInvestigationResult,
  validateInvestigationTrace,
  type InvestigationConfiguration,
  type InvestigationClaim,
  type InvestigationIntentWriter,
  type InvestigationRepository,
  type InvestigationRunResult,
  type InvestigationTraceEvent,
  type TraceWriter,
} from "@bitsentry-escalator/features/investigation";
/** Callbacks run inside short transactions: local/DB authorization only, no network I/O.
 * Lock mutable authorization and configuration rows until transaction end. */
export interface InvestigationDatabasePolicy {
  authorizeRuntime(
    db: PoolClient,
    workspaceId: WorkspaceId,
    runtimeId: string,
  ): Promise<boolean>;
  configuration(
    db: PoolClient,
    scope: InvestigationScope,
    profileId: string,
  ): Promise<InvestigationConfiguration | undefined>;
}
interface Row {
  id: string;
  incident_id: string;
  service_id: string;
  environment_id: string;
  profile_id: string;
  configuration: unknown;
  limits: unknown;
  sources: unknown;
  runtime_id: string | null;
  idempotency_key: string;
  state: string;
  attempt_count: number;
  lease_token: string | null;
  lease_expires_at: Date | null;
  live: boolean;
}
/** Uses the host's reserved investigation pool; never holds a connection during model work. */
export class PostgresInvestigationRepository implements InvestigationRepository {
  readonly trace: TraceWriter = {
    append: (claim, event) => this.append(claim, event),
  };
  constructor(
    private readonly pool: Pool,
    private readonly policy: InvestigationDatabasePolicy,
    private readonly maxAttempts = 3,
  ) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5)
      throw new Error("Invalid investigation attempt limit");
  }
  private async scoped<T>(
    workspaceId: WorkspaceId,
    work: (db: PoolClient) => Promise<T>,
  ): Promise<T> {
    return investigationTransaction(this.pool, workspaceId, work);
  }

  /** Join an already scoped paging transaction; this method never commits it. */
  writer(db: PoolClient, workspaceId: WorkspaceId): InvestigationIntentWriter {
    return PostgresInvestigationRepository.createWriter(
      db,
      workspaceId,
      (connection, scope, id) =>
        this.policy.configuration(connection, scope, id),
    );
  }
  /** Factory for an existing paging connection; requires no runner pool or runtime authority. */
  static createWriter(
    db: PoolClient,
    workspaceId: WorkspaceId,
    configuration: InvestigationDatabasePolicy["configuration"],
  ): InvestigationIntentWriter {
    return {
      enqueue: async (input) => {
        const intent = investigationIntentSchema.parse(input);
        if (intent.scope.workspaceId !== workspaceId)
          throw new Error("Investigation scope mismatch");
        const previous = await db.query<{
          id: string;
          investigation_id: string | null;
        }>(
          `SELECT j.id,i.id AS investigation_id FROM escalator_job j LEFT JOIN escalator_investigation i ON i.workspace_id=j.workspace_id AND i.id=j.id WHERE j.workspace_id=$1 AND j.kind='investigation.run' AND j.idempotency_key=$2`,
          [workspaceId, intent.idempotencyKey],
        );
        if (previous.rows[0]) {
          if (!previous.rows[0].investigation_id)
            throw new Error("Investigation job is incomplete");
          return "duplicate";
        }
        const captured = captureInvestigation(
          intent,
          await configuration(db, intent.scope, intent.profileId),
        );
        const inserted = await db.query(
          `INSERT INTO escalator_job(workspace_id,id,kind,idempotency_key,payload,due_at) VALUES($1,$2,'investigation.run',$3,$4::jsonb,clock_timestamp()) ON CONFLICT(workspace_id,kind,idempotency_key) DO NOTHING RETURNING id`,
          [
            workspaceId,
            intent.id,
            intent.idempotencyKey,
            JSON.stringify({
              investigationId: intent.id,
              secretIds: captured.configuration.secretIds,
            }),
          ],
        );
        if (!inserted.rowCount) {
          const existing = await db.query(
            `SELECT i.id FROM escalator_investigation i JOIN escalator_job j ON j.workspace_id=i.workspace_id AND j.id=i.id WHERE j.workspace_id=$1 AND j.kind='investigation.run' AND j.idempotency_key=$2`,
            [workspaceId, intent.idempotencyKey],
          );
          if (existing.rowCount !== 1)
            throw new Error("Investigation job is incomplete");
          return "duplicate";
        }
        await db.query(
          `INSERT INTO escalator_investigation(workspace_id,id,incident_id,service_id,environment_id,profile_id,configuration,limits,sources) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb)`,
          [
            workspaceId,
            intent.id,
            intent.scope.incidentId,
            intent.scope.serviceId,
            intent.scope.environmentId,
            intent.profileId,
            JSON.stringify(captured.configuration),
            JSON.stringify(intent.limits),
            JSON.stringify(intent.sources),
          ],
        );
        return "inserted";
      },
    };
  }
  /** Test/administrative composition; incident creation instead uses writer in its own transaction. */
  async enqueue(input: Parameters<InvestigationIntentWriter["enqueue"]>[0]) {
    return this.scoped(input.scope.workspaceId, (db) =>
      this.writer(db, input.scope.workspaceId).enqueue(input),
    );
  }
  private async locked(
    db: PoolClient,
    scope: WorkspaceId,
    id: string,
  ): Promise<Row | undefined> {
    const found = await db.query(
      `SELECT id FROM escalator_investigation WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
      [scope, id],
    );
    if (!found.rowCount) return undefined;
    await db.query(
      `SELECT id FROM escalator_job WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
      [scope, id],
    );
    const rows = await db.query<Row>(
      `SELECT i.id,i.incident_id,i.service_id,i.environment_id,i.profile_id,i.configuration,i.limits,i.sources,i.runtime_id,j.idempotency_key,j.state,j.attempt_count,j.lease_token,j.lease_expires_at,(j.state='running' AND j.lease_expires_at>clock_timestamp()) AS live FROM escalator_investigation i JOIN escalator_job j ON j.workspace_id=i.workspace_id AND j.id=i.id AND j.kind='investigation.run' WHERE i.workspace_id=$1 AND i.id=$2`,
      [scope, id],
    );
    return rows.rows[0];
  }
  private captured(scope: WorkspaceId, row: Row) {
    return captureInvestigation(
      {
        id: row.id,
        scope: {
          workspaceId: scope,
          incidentId: row.incident_id,
          serviceId: row.service_id,
          environmentId: row.environment_id,
        },
        profileId: row.profile_id,
        limits: row.limits,
        sources: row.sources,
        idempotencyKey: row.idempotency_key,
      },
      row.configuration,
    );
  }
  private claimValue(scope: WorkspaceId, row: Row): InvestigationClaim {
    const { intent } = this.captured(scope, row);
    return investigationClaimSchema.parse({
      id: intent.id,
      scope: intent.scope,
      profileId: intent.profileId,
      limits: intent.limits,
      sources: intent.sources,
      runtimeId: row.runtime_id,
      claimToken: row.lease_token,
      leaseExpiresAt: row.lease_expires_at?.toISOString(),
      attempt: row.attempt_count,
    });
  }
  private async currentConfiguration(
    db: PoolClient,
    scope: WorkspaceId,
    row: Row,
  ) {
    const captured = this.captured(scope, row);
    return sameInvestigationConfiguration(
      captured.configuration,
      await this.policy.configuration(
        db,
        captured.intent.scope,
        row.profile_id,
      ),
    );
  }
  async claim(
    input: Parameters<InvestigationRepository["claim"]>[0],
  ): Promise<InvestigationClaim | undefined> {
    opaqueIdSchema.parse(input.runtimeId);
    opaqueIdSchema.parse(input.claimToken);
    if (
      !Number.isInteger(input.leaseMs) ||
      input.leaseMs < 3000 ||
      input.leaseMs > 120000
    )
      throw new Error("Invalid investigation lease");
    return this.scoped(input.workspaceId, async (db) => {
      if (
        !(await this.policy.authorizeRuntime(
          db,
          input.workspaceId,
          input.runtimeId,
        ))
      )
        return undefined;
      const candidate = await db.query<{ id: string }>(
        `SELECT i.id FROM escalator_investigation i JOIN escalator_job j ON j.workspace_id=i.workspace_id AND j.id=i.id WHERE i.workspace_id=$1 AND j.kind='investigation.run' AND ((j.state='pending' AND j.due_at<=clock_timestamp()) OR (j.state='running' AND j.lease_expires_at<=clock_timestamp())) ORDER BY j.due_at,i.id FOR UPDATE OF i SKIP LOCKED LIMIT 1`,
        [input.workspaceId],
      );
      if (!candidate.rows[0]) return undefined;
      const row = await this.locked(
        db,
        input.workspaceId,
        candidate.rows[0].id,
      );
      if (
        !row ||
        row.live ||
        !["pending", "running"].includes(row.state) ||
        row.lease_token === input.claimToken
      )
        return undefined;
      if (
        !(await this.policy.authorizeRuntime(
          db,
          input.workspaceId,
          input.runtimeId,
        ))
      )
        return undefined;
      if (
        row.attempt_count >= this.maxAttempts ||
        !(await this.currentConfiguration(db, input.workspaceId, row))
      ) {
        await db.query(
          `UPDATE escalator_job SET state='failed',lease_token=NULL,lease_expires_at=NULL,completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,
          [input.workspaceId, row.id],
        );
        return undefined;
      }
      const claimed = await db.query(
        `UPDATE escalator_job SET state='running',lease_token=$3,lease_expires_at=clock_timestamp()+($4::integer*interval '1 millisecond'),attempt_count=attempt_count+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND kind='investigation.run' AND lease_token IS DISTINCT FROM $3 AND ((state='pending' AND due_at<=clock_timestamp()) OR (state='running' AND lease_expires_at<=clock_timestamp())) RETURNING id`,
        [input.workspaceId, row.id, input.claimToken, input.leaseMs],
      );
      if (claimed.rowCount !== 1) return undefined;
      await db.query(
        `UPDATE escalator_investigation SET runtime_id=$3,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,
        [input.workspaceId, row.id, input.runtimeId],
      );
      return this.claimValue(
        input.workspaceId,
        (await this.locked(db, input.workspaceId, row.id))!,
      );
    });
  }
  private async fence(db: PoolClient, input: InvestigationClaim) {
    const row = await this.locked(db, input.scope.workspaceId, input.id);
    if (!row?.live) return undefined;
    const claim = this.claimValue(input.scope.workspaceId, row);
    if (
      !sameInvestigationClaim(input, claim) ||
      !(await this.policy.authorizeRuntime(
        db,
        claim.scope.workspaceId,
        claim.runtimeId,
      )) ||
      !(await this.currentConfiguration(db, claim.scope.workspaceId, row))
    )
      return undefined;
    return { row, claim };
  }
  async readClaim(key: {
    workspaceId: WorkspaceId;
    id: string;
    runtimeId: string;
    claimToken: string;
  }): Promise<InvestigationClaim | undefined> {
    return this.scoped(key.workspaceId, async (db) => {
      const row = await this.locked(db, key.workspaceId, key.id);
      if (
        !row?.live ||
        row.runtime_id !== key.runtimeId ||
        row.lease_token !== key.claimToken
      )
        return undefined;
      return (await this.fence(db, this.claimValue(key.workspaceId, row)))
        ?.claim;
    });
  }
  async heartbeat(input: InvestigationClaim, leaseMs: number) {
    if (!Number.isInteger(leaseMs) || leaseMs < 3000 || leaseMs > 120000)
      throw new Error("Invalid investigation lease");
    return this.scoped(input.scope.workspaceId, async (db) => {
      const value = await this.fence(db, input);
      if (!value) return undefined;
      const rows = await db.query<{ lease_expires_at: Date }>(
        `UPDATE escalator_job SET lease_expires_at=clock_timestamp()+($4::integer*interval '1 millisecond'),updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND state='running' AND lease_token=$3 AND lease_expires_at>clock_timestamp() RETURNING lease_expires_at`,
        [input.scope.workspaceId, input.id, input.claimToken, leaseMs],
      );
      return rows.rows[0]
        ? { leaseExpiresAt: rows.rows[0].lease_expires_at.toISOString() }
        : undefined;
    });
  }
  async publish(
    input: InvestigationClaim,
    result: InvestigationRunResult,
  ): Promise<boolean> {
    return this.scoped(input.scope.workspaceId, async (db) => {
      const value = await this.fence(db, input);
      if (!value) return false;
      let checked;
      try {
        checked = validateInvestigationResult(value.claim, result);
      } catch {
        return false;
      }
      const destination = this.captured(input.scope.workspaceId, value.row)
        .configuration.profile.destination;
      if (
        checked.report.status === "complete" &&
        checked.report.destination === null
      )
        return false;
      if (
        checked.report.destination !== null &&
        JSON.stringify(checked.report.destination) !==
          JSON.stringify(destination)
      )
        return false;
      const updated = await db.query(
        `UPDATE escalator_job SET state='completed',lease_token=NULL,lease_expires_at=NULL,completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND state='running' AND lease_token=$3 AND lease_expires_at>clock_timestamp() RETURNING id`,
        [input.scope.workspaceId, input.id, input.claimToken],
      );
      if (updated.rowCount !== 1) return false;
      if (checked.evidence.length)
        await db.query(
          `INSERT INTO escalator_investigation_evidence(workspace_id,investigation_id,id,data) SELECT $1,$2,e.value->'reference'->>'id',e.value FROM jsonb_array_elements($3::jsonb) AS e(value)`,
          [input.scope.workspaceId, input.id, JSON.stringify(checked.evidence)],
        );
      await db.query(
        `UPDATE escalator_investigation SET report=$3::jsonb,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,
        [input.scope.workspaceId, input.id, JSON.stringify(checked.report)],
      );
      return true;
    });
  }
  private async append(
    input: InvestigationClaim,
    event: InvestigationTraceEvent,
  ): Promise<boolean> {
    return this.scoped(input.scope.workspaceId, async (db) => {
      const value = await this.fence(db, input);
      if (!value) return false;
      let checked;
      try {
        checked = validateInvestigationTrace(value.claim, event);
      } catch {
        return false;
      }
      const prior = await db.query<{ data: unknown }>(
        `SELECT t.data FROM escalator_investigation_trace t JOIN escalator_job j ON j.workspace_id=t.workspace_id AND j.id=t.investigation_id WHERE t.workspace_id=$1 AND t.investigation_id=$2 AND t.sequence=$3 AND t.attempt=$5 AND j.state='running' AND j.lease_token=$4 AND j.lease_expires_at>clock_timestamp()`,
        [
          input.scope.workspaceId,
          input.id,
          checked.sequence,
          input.claimToken,
          value.claim.attempt,
        ],
      );
      if (prior.rows[0])
        return (
          JSON.stringify(
            validateInvestigationTrace(value.claim, prior.rows[0].data),
          ) === JSON.stringify(checked)
        );
      const written = await db.query(
        `INSERT INTO escalator_investigation_trace(workspace_id,investigation_id,attempt,sequence,data) SELECT $1,$2,$6::integer,$3,$4::jsonb FROM escalator_job WHERE workspace_id=$1 AND id=$2 AND state='running' AND lease_token=$5 AND lease_expires_at>clock_timestamp()`,
        [
          input.scope.workspaceId,
          input.id,
          checked.sequence,
          JSON.stringify(checked),
          input.claimToken,
          value.claim.attempt,
        ],
      );
      return written.rowCount === 1;
    });
  }
  async get(scope: InvestigationScope, id: string) {
    const parsed = investigationScopeSchema.parse(scope);
    return this.scoped(parsed.workspaceId, async (db) => {
      const rows = await db.query<{ report: unknown }>(
        `SELECT report FROM escalator_investigation WHERE workspace_id=$1 AND id=$2 AND incident_id=$3 AND service_id=$4 AND environment_id=$5`,
        [
          parsed.workspaceId,
          id,
          parsed.incidentId,
          parsed.serviceId,
          parsed.environmentId,
        ],
      );
      if (!rows.rows[0]?.report) return undefined;
      const report = investigationReportSchema.parse(rows.rows[0].report);
      if (JSON.stringify(report.scope) !== JSON.stringify(parsed))
        throw new Error("Stored investigation scope mismatch");
      return report;
    });
  }
  async getEvidence(scope: InvestigationScope, id: string) {
    const parsed = investigationScopeSchema.parse(scope);
    return this.scoped(parsed.workspaceId, async (db) => {
      const rows = await db.query<{ data: unknown }>(
        `SELECT e.data FROM escalator_investigation_evidence e JOIN escalator_investigation i ON i.workspace_id=e.workspace_id AND i.id=e.investigation_id WHERE i.workspace_id=$1 AND i.id=$2 AND i.incident_id=$3 AND i.service_id=$4 AND i.environment_id=$5 AND i.report IS NOT NULL ORDER BY e.id LIMIT 129`,
        [
          parsed.workspaceId,
          id,
          parsed.incidentId,
          parsed.serviceId,
          parsed.environmentId,
        ],
      );
      if (rows.rows.length > 128)
        throw new Error("Stored investigation evidence exceeds limit");
      return rows.rows.map((row) => {
        const item = investigationEvidenceSchema.parse(row.data);
        if (JSON.stringify(item.scope) !== JSON.stringify(parsed))
          throw new Error("Stored investigation scope mismatch");
        return item;
      });
    });
  }
}
