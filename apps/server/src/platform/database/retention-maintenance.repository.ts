import { postgresRetireMaintenanceWork } from "./postgres-retired-work.js";
import type { Pool, PoolClient } from "pg";
import {
  opaqueIdSchema,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import {
  PersistenceError,
  retentionMaintenanceStateSchema,
  retentionMaintenanceTransaction,
  replayPruneTransaction,
  type RetentionMaintenanceRepository,
  type RetentionMaintenanceState,
  type RetentionMaintenanceTransaction,
  type RetentionMaintenanceStore,
  type RetentionMaintenanceWork,
} from "@bitsentry-escalator/features/application";
import { PostgresFoundationRepository } from "./foundation.repository.js";
import { postgresSignalStore } from "./postgres-signals.store.js";
import { postgresReplayPruneStore } from "./retention-prune.repository.js";
type Row = {
  revision: string;
  jobId: string;
  dueAt: Date;
  sourceId: string | null;
  after: unknown;
  sweepStartedAt: Date | null;
  completedAt: Date | null;
};
const fields = `revision::text,current_job_id AS "jobId",due_at AS "dueAt",source_id AS "sourceId",receipt_cursor AS "after",sweep_started_at AS "sweepStartedAt",completed_at AS "completedAt"`;
function decode(scope: WorkspaceId, row: Row | undefined) {
  return row
    ? retentionMaintenanceStateSchema.parse({
        workspaceId: scope,
        revision: Number(row.revision),
        jobId: row.jobId,
        dueAt: row.dueAt.toISOString(),
        sourceId: row.sourceId,
        after: row.after,
        sweepStartedAt: row.sweepStartedAt?.toISOString() ?? null,
        completedAt: row.completedAt?.toISOString() ?? null,
      })
    : undefined;
}
function maintenanceStore(
  db: PoolClient,
  scope: WorkspaceId,
): RetentionMaintenanceStore {
  return {
    async lock() {
      // The advisory lock also serializes an absent singleton; it precedes all job locks.
      await db.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text",
        [`escalator:retention:${scope}`],
      );
      const result = await db.query<Row>(
        `SELECT ${fields} FROM escalator_retention_schedule WHERE workspace_id=$1 FOR UPDATE`,
        [scope],
      );
      return decode(scope, result.rows[0]);
    },
    async lockWork(id) {
      const result = await db.query<RetentionMaintenanceWork>(
        "SELECT kind,state,payload FROM escalator_job WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [scope, id],
      );
      return result.rows[0];
    },
    async put(value: RetentionMaintenanceState, expected) {
      const args = [
        scope,
        BigInt(value.revision),
        value.jobId,
        value.dueAt,
        value.sourceId,
        value.after === null ? null : JSON.stringify(value.after),
        value.sweepStartedAt,
        value.completedAt,
      ];
      const sql =
        expected === null
          ? `INSERT INTO escalator_retention_schedule(workspace_id,revision,current_job_id,due_at,source_id,receipt_cursor,sweep_started_at,completed_at)
           VALUES($1,$2::bigint,$3,$4::timestamptz,$5,$6::jsonb,$7::timestamptz,$8::timestamptz) ON CONFLICT DO NOTHING RETURNING workspace_id`
          : `UPDATE escalator_retention_schedule SET revision=$2::bigint,current_job_id=$3,due_at=$4::timestamptz,source_id=$5,receipt_cursor=$6::jsonb,sweep_started_at=$7::timestamptz,completed_at=$8::timestamptz WHERE workspace_id=$1 AND revision=$9::bigint RETURNING workspace_id`;
      const result = await db.query(
        sql,
        expected === null ? args : [...args, BigInt(expected)],
      );
      return result.rows.length === 1;
    },
    retireWork: (state, now) =>
      postgresRetireMaintenanceWork(db, scope, state, now),
    async nextSource(after) {
      const result = await db.query<{ id: string }>(
        'SELECT id FROM escalator_signal_source WHERE workspace_id=$1 AND ($2::text IS NULL OR id>$2) ORDER BY id COLLATE "C" LIMIT 1',
        [scope, after],
      );
      return result.rows[0]?.id;
    },
  };
}
export class PostgresRetentionMaintenanceRepository implements RetentionMaintenanceRepository {
  private readonly foundation: PostgresFoundationRepository;
  constructor(pool: Pool) {
    this.foundation = new PostgresFoundationRepository(pool);
  }
  read(scope: WorkspaceId) {
    return this.foundation.withConnection(scope, async (_base, db) => {
      await db.query("SET LOCAL statement_timeout = '5s'");
      const result = await db.query<Row>(
        `SELECT ${fields} FROM escalator_retention_schedule WHERE workspace_id=$1`,
        [scope],
      );
      return decode(scope, result.rows[0]);
    });
  }
  transaction<T>(
    scope: WorkspaceId,
    sourceHint: string | null,
    run: (tx: RetentionMaintenanceTransaction) => Promise<T>,
  ): Promise<T> {
    if (sourceHint !== null) opaqueIdSchema.parse(sourceHint);
    return this.foundation.withConnection(scope, async (base, db, guard) => {
      await db.query("SET LOCAL statement_timeout = '5s'");
      await db.query("SET LOCAL lock_timeout = '1s'");
      if (
        sourceHint !== null &&
        !(await postgresSignalStore(db, scope).getSource(sourceHint, true))
      )
        throw new PersistenceError("not_found");
      const noSource = async (): Promise<never> => {
        throw new Error("Control transaction cannot prune receipts");
      };
      const prune = replayPruneTransaction(
        base,
        sourceHint === null
          ? { snapshot: noSource, remove: noSource }
          : postgresReplayPruneStore(db, scope, sourceHint),
        guard,
      );
      return run(
        retentionMaintenanceTransaction(
          prune,
          maintenanceStore(db, scope),
          guard,
        ),
      );
    });
  }
}
