import { RepositoryConnections } from "@bitsentry-escalator/features/investigation";
import {
  readRepositoryBinding,
  readRepositoryComparison,
} from "./postgres-repository-evidence.js";
import type { SecretEnvelope } from "../secrets/keyring.js";
import { readNativeEvidence } from "./postgres-native-evidence.js";
import { investigationTransaction } from "./investigation-transaction.js";
import type { Pool, PoolClient } from "pg";
import {
  investigationScopeSchema,
  evidenceQuerySchema,
  type EvidenceQuery,
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
    private readonly repositoryConnections = new RepositoryConnections(),
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
  /** Standalone-only encrypted envelope projection, never exposed as a machine endpoint. */
  async readModelSecret(input: InvestigationClaim, secretId: string) {
    const claim = investigationClaimSchema.parse(input);
    opaqueIdSchema.parse(secretId);
    return this.scoped(claim.scope.workspaceId, async (db) => {
      const value = await this.fence(db, claim);
      if (!value) return undefined;
      const configuration = this.captured(
        claim.scope.workspaceId,
        value.row,
      ).configuration;
      if (
        configuration.profile.secretId !== secretId ||
        !configuration.secretIds.includes(secretId)
      )
        return undefined;
      const records = await db.query<{ id: string; envelope: SecretEnvelope }>(
        "SELECT id,envelope FROM escalator_secret WHERE workspace_id=$1 AND id=$2 AND purpose='provider' AND disabled_at IS NULL FOR SHARE",
        [claim.scope.workspaceId, secretId],
      );
      if (!records.rows[0]) return undefined;
      const current = await this.locked(db, claim.scope.workspaceId, claim.id);
      if (!current?.live) return undefined;
      const clock = await db.query<{ now: Date }>(
        "SELECT clock_timestamp() AS now",
        [],
      );
      return {
        id: secretId,
        workspaceId: claim.scope.workspaceId,
        envelope: records.rows[0].envelope,
        disabled: false,
        claim: {
          workspaceId: claim.scope.workspaceId,
          workId: claim.id,
          queue: "job" as const,
          state: current.state,
          token: current.lease_token,
          expiresAt: current.lease_expires_at?.toISOString() ?? null,
          databaseNow: clock.rows[0].now.toISOString(),
          approvedSecretIds: [secretId],
        },
      };
    });
  }
  /** Local snapshot only; commit before decrypting credentials or reading the provider.
   * Source IDs and secret IDs are taken from captured configuration, never model input. */
  async readRepositoryEvidence(
    input: InvestigationClaim,
    queryInput: EvidenceQuery,
  ) {
    const claim = investigationClaimSchema.parse(input);
    const query = evidenceQuerySchema.parse(queryInput);
    if (query.kind !== "git_diff") return undefined;
    return this.scoped(claim.scope.workspaceId, async (db) => {
      const value = await this.fence(db, claim);
      if (
        !value ||
        !value.claim.sources.some(
          (source) =>
            source.kind === query.kind &&
            source.sourceId === query.sourceId &&
            source.limit === query.limit &&
            source.window.from === query.window.from &&
            source.window.to === query.window.to,
        )
      )
        return undefined;
      const captured = this.captured(
        claim.scope.workspaceId,
        value.row,
      ).configuration;
      const binding = await readRepositoryBinding(
        db,
        claim.scope,
        query.sourceId,
        this.repositoryConnections,
      );
      if (
        !binding ||
        !captured.sourceVersions.some(
          (source) =>
            source.kind === "git_diff" &&
            source.sourceId === query.sourceId &&
            source.revision === binding.revision,
        )
      )
        return undefined;
      const id = binding.connection.secretId;
      if (id !== null && !captured.secretIds.includes(id)) return undefined;
      const records =
        id === null
          ? undefined
          : await db.query<{ envelope: SecretEnvelope }>(
              "SELECT envelope FROM escalator_secret WHERE workspace_id=$1 AND id=$2 AND purpose='provider' AND disabled_at IS NULL FOR SHARE",
              [claim.scope.workspaceId, id],
            );
      if (id !== null && !records?.rows[0]) return undefined;
      const clock = await db.query<{ now: Date }>(
        "SELECT clock_timestamp() AS now",
        [],
      );
      const comparison = await readRepositoryComparison(
        db,
        claim.scope,
        query,
        binding.connection,
        clock.rows[0].now.toISOString(),
      );
      if (!comparison || !(await this.fence(db, claim))) return undefined;
      const current = await this.locked(db, claim.scope.workspaceId, claim.id);
      if (!current?.live) return undefined;
      const finalClock = await db.query<{ now: Date }>(
        "SELECT clock_timestamp() AS now",
        [],
      );
      if (
        !current.lease_expires_at ||
        current.lease_expires_at <= finalClock.rows[0].now
      )
        return undefined;
      return {
        comparison,
        secret:
          id === null
            ? null
            : {
                id,
                workspaceId: claim.scope.workspaceId,
                disabled: false,
                envelope: records!.rows[0].envelope,
                claim: {
                  workspaceId: claim.scope.workspaceId,
                  workId: claim.id,
                  queue: "job" as const,
                  state: current.state,
                  token: current.lease_token,
                  expiresAt: current.lease_expires_at.toISOString(),
                  databaseNow: finalClock.rows[0].now.toISOString(),
                  approvedSecretIds: [id],
                },
              },
      };
    });
  }
  /** Internal runner access. A profile is returned only under the same live claim fence. */
  async readProfile(input: InvestigationClaim) {
    const claim = investigationClaimSchema.parse(input);
    return this.scoped(claim.scope.workspaceId, async (db) => {
      const value = await this.fence(db, claim);
      if (
        !value ||
        !(await this.locked(db, claim.scope.workspaceId, claim.id))?.live
      )
        return undefined;
      return this.captured(claim.scope.workspaceId, value.row).configuration
        .profile;
    });
  }
  /** No arbitrary source/window reads: use the immutable query captured with the claim. */
  async readNativeEvidence(
    input: InvestigationClaim,
    queryInput: EvidenceQuery,
    maxBytes: number,
  ) {
    const claim = investigationClaimSchema.parse(input);
    const query = evidenceQuerySchema.parse(queryInput);
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 262144)
      throw new RangeError("Invalid evidence byte limit");
    const denied = () => ({
      status: "unavailable" as const,
      unavailable: { query, reason: "not_authorized" as const },
    });
    return this.scoped(claim.scope.workspaceId, async (db) => {
      const value = await this.fence(db, claim);
      if (
        !value ||
        !value.claim.sources.some(
          (source) =>
            source.kind === query.kind &&
            source.sourceId === query.sourceId &&
            source.limit === query.limit &&
            source.window.from === query.window.from &&
            source.window.to === query.window.to,
        )
      )
        return denied();
      const clock = await db.query<{ now: Date }>(
        "SELECT clock_timestamp() AS now",
        [],
      );
      const result = await readNativeEvidence(
        db,
        value.claim.scope,
        query,
        clock.rows[0].now.toISOString(),
        maxBytes,
      );
      // A bounded query can still outlive its lease. Do not release its result after expiry/revocation.
      if (!(await this.fence(db, claim))) return denied();
      // Check database time after authorization queries as well as after the evidence read.
      return (await this.locked(db, claim.scope.workspaceId, claim.id))?.live
        ? result
        : denied();
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
