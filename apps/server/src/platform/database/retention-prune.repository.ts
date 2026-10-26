import type { Pool, PoolClient } from "pg";
import {
  opaqueIdSchema,
  metricMonitorSchema,
  replayRetentionPolicySchema,
  type WorkspaceId,
  expectDefined,
} from "@bitsentry-escalator/features/contracts";
import {
  PersistenceError,
  replayPruneTransaction,
  replayReceiptProtection,
  type ReplayPruneRepository,
  type ReplayPruneTransaction,
  type ReplayPruneStore,
  type ReplayPruneSnapshot,
  type ReplayPruneCursor,
  type PruneWorkRecord,
} from "@bitsentry-escalator/features/application";
import { PostgresFoundationRepository } from "./foundation.repository.js";
import { postgresSignalStore } from "./postgres-signals.store.js";
type Row = {
  kind: "signal" | "probe" | "metric";
  id: string;
  ownerId: string | null;
  version: string | null;
  observedAt: string;
  bytes: string;
  referenced: boolean;
  processed: boolean;
};
const stamp = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
// Closed internal identifiers only; every scope, source and cursor value is bound.
function stream(kind: Row["kind"]) {
  const [table, parent, parameter, version] = {
    signal: ["escalator_signal_event", "source_id", 2, "NULL::bigint"],
    probe: ["escalator_probe_result", "probe_id", 6, "probe_version"],
    metric: [
      "escalator_metric_observation",
      "monitor_id",
      7,
      "monitor_version",
    ],
  }[kind];
  return `SELECT '${kind}'::text AS kind,id,${kind === "signal" ? "NULL::text" : parent} AS owner_id,
    ${version} AS version,observed_at,payload_bytes
    FROM ${table} WHERE workspace_id=$1 AND ${parent}=$${parameter}::text
    AND ($3::timestamptz IS NULL OR (observed_at,'${kind}'::text COLLATE "C",id COLLATE "C")>
      ($3::timestamptz,$4::text COLLATE "C",$5::text COLLATE "C"))
    ORDER BY observed_at,id COLLATE "C" LIMIT 1001`;
}
const candidatesSql = `WITH signals AS MATERIALIZED (${stream("signal")}),
 probes AS MATERIALIZED (${stream("probe")}), metrics AS MATERIALIZED (${stream("metric")}),
 candidates AS MATERIALIZED (
  SELECT * FROM (SELECT * FROM signals UNION ALL SELECT * FROM probes UNION ALL SELECT * FROM metrics) r
  ORDER BY observed_at,kind COLLATE "C",id COLLATE "C" LIMIT 1001
 ) SELECT c.kind,c.id,c.owner_id AS "ownerId",c.version::text,
 ${stamp("c.observed_at")} AS "observedAt",c.payload_bytes::text AS bytes,
 CASE c.kind
 WHEN 'signal' THEN EXISTS(SELECT 1 FROM escalator_detection_alert a WHERE a.workspace_id=$1 AND a.last_signal_id=c.id)
 WHEN 'probe' THEN EXISTS(SELECT 1 FROM escalator_probe_state s WHERE s.workspace_id=$1 AND s.probe_id=c.owner_id AND s.last_result_id=c.id)
  OR EXISTS(SELECT 1 FROM escalator_probe_schedule s WHERE s.workspace_id=$1 AND s.probe_id=c.owner_id AND s.job_id=c.id)
 ELSE EXISTS(SELECT 1 FROM escalator_metric_schedule s WHERE s.workspace_id=$1 AND s.monitor_id=c.owner_id AND (s.last_observation_id=c.id OR s.job_id=c.id)) END OR EXISTS(SELECT 1 FROM escalator_deployment_pin pin WHERE pin.workspace_id=$1 AND pin.source_id=$2
  AND pin.starts_at<=c.observed_at AND pin.ends_at>c.observed_at AND pin.expires_at>statement_timestamp()) AS referenced,
 (c.kind<>'signal' OR EXISTS(SELECT 1 FROM escalator_detection_processed p WHERE p.workspace_id=$1 AND p.source_id=$2 AND p.id=c.id)) AS processed
 FROM candidates c ORDER BY c.observed_at,c.kind COLLATE "C",c.id COLLATE "C"`;
export function postgresReplayPruneStore(
  db: PoolClient,
  scope: WorkspaceId,
  sourceId: string,
): ReplayPruneStore {
  const query = async <R>(sql: string, values: unknown[] = []) =>
    (await db.query(sql, values)).rows as R[];
  let selectedRows: Row[] = [];
  let probeId: string | null = null,
    monitorId: string | null = null;
  const workId = (row: Pick<Row, "kind" | "id">) =>
    row.kind === "signal" ? `signal.process:${row.id}` : row.id;
  const count = async () => {
    const rows = await query<{ bytes: string }>(
      "SELECT payload_bytes::text AS bytes FROM escalator_replay_usage WHERE workspace_id=$1",
      [scope],
    );
    if (rows.length !== 1) throw new Error("Replay accounting row unavailable");
    return Number(rows[0].bytes);
  };
  return {
    async snapshot(
      after: ReplayPruneCursor | null,
    ): Promise<ReplayPruneSnapshot> {
      // Source is already locked. Bounded expiry cleanup precedes work/accounting locks.
      await query(
        `DELETE FROM escalator_deployment_pin WHERE workspace_id=$1 AND source_id=$2
        AND (deployment_id,purpose) IN (SELECT deployment_id,purpose FROM escalator_deployment_pin
          WHERE workspace_id=$1 AND source_id=$2 AND expires_at<=clock_timestamp()
          ORDER BY expires_at,deployment_id COLLATE "C",purpose LIMIT 100)`,
        [scope, sourceId],
      );
      const [config] = await query<{
        probeId: string | null;
        metricData: Record<string, unknown> | null;
      }>(
        'SELECT p.id AS "probeId",m.data AS "metricData" FROM (SELECT 1) one LEFT JOIN escalator_probe p ON p.workspace_id=$1 AND p.source_id=$2 LEFT JOIN escalator_metric_monitor m ON m.workspace_id=$1 AND m.source_id=$2',
        [scope, sourceId],
      );
      probeId = config.probeId;
      const monitor = config.metricData
        ? metricMonitorSchema.parse({
            ...config.metricData,
            workspaceId: scope,
          })
        : null;
      monitorId = monitor?.id ?? null;
      const rows = await query<Row>(candidatesSql, [
        scope,
        sourceId,
        after?.observedAt ?? null,
        after?.kind ?? null,
        after?.id ?? null,
        probeId,
        monitorId,
      ]);
      selectedRows = rows.slice(0, 1000);
      // Work locks precede accounting. Never take another source lock afterward.
      const jobs = await query<PruneWorkRecord>(
        `SELECT id,kind,state,payload,lease_token AS "leaseToken",
        ${stamp("lease_expires_at")} AS "leaseExpiresAt",${stamp("completed_at")} AS "completedAt"
        FROM escalator_job WHERE workspace_id=$1 AND id=ANY($2::text[]) ORDER BY id COLLATE "C" FOR UPDATE`,
        [scope, [...new Set(selectedRows.map(workId))]],
      );
      const locked = await query<{ workspace_id: string }>(
        "SELECT workspace_id FROM escalator_replay_usage WHERE workspace_id=$1 FOR UPDATE",
        [scope],
      );
      if (locked.length !== 1)
        throw new Error("Replay accounting row unavailable");
      const [clock] = await query<{ now: string }>(
        `SELECT ${stamp("clock_timestamp()")} AS now`,
      );
      const policies = await query<{
        days: number;
        maxBytes: string;
        version: string;
        updatedAt: string;
      }>(
        `SELECT days,max_bytes::text AS "maxBytes",version::text,${stamp("updated_at")} AS "updatedAt" FROM escalator_retention_policy WHERE workspace_id=$1`,
        [scope],
      );
      const policy = policies[0]
        ? replayRetentionPolicySchema.parse({
            workspaceId: scope,
            days: policies[0].days,
            maxBytes: Number(policies[0].maxBytes),
            version: Number(policies[0].version),
            updatedAt: policies[0].updatedAt,
          })
        : null;
      const protectedReceipt = replayReceiptProtection(
        scope,
        monitor,
        clock.now,
      );
      const byId = new Map(jobs.map((job) => [job.id, job]));
      return {
        databaseNow: clock.now,
        retainedBytes: await count(),
        policy,
        hasMore: rows.length > 1000,
        candidates: selectedRows.map((row) => ({
          workspaceId: scope,
          sourceId,
          kind: row.kind,
          id: row.id,
          observedAt: row.observedAt,
          bytes: Number(row.bytes),
          protected: protectedReceipt(
            {
              ...(row.kind === "signal"
                ? { kind: "signal" as const, id: row.id }
                : {
                    kind: row.kind,
                    id: row.id,
                    ownerId: expectDefined(row.ownerId, "receipt owner"),
                    version: Number(row.version),
                  }),
              observedAt: row.observedAt,
              referenced: row.referenced,
              processed: row.processed,
            },
            byId.get(workId(row)),
          ),
        })),
      };
    },
    async remove(selected) {
      const keys = new Set(selected.map((row) => `${row.kind}:${row.id}`));
      const rows = selectedRows.filter((row) =>
        keys.has(`${row.kind}:${row.id}`),
      );
      if (rows.length !== selected.length)
        throw new Error("Unknown retention selection");
      const jobIds = rows.map(workId);
      if (new Set(jobIds).size !== jobIds.length)
        throw new Error("Ambiguous receipt job identity");
      const signals = rows
        .filter((row) => row.kind === "signal")
        .map((row) => row.id);
      if (signals.length) {
        await query(
          `INSERT INTO escalator_signal_tombstone(workspace_id,signal_id,source_id,retained_at)
          SELECT workspace_id,id,source_id,clock_timestamp() FROM escalator_signal_event
          WHERE workspace_id=$1 AND source_id=$2 AND id=ANY($3::text[]) ON CONFLICT DO NOTHING RETURNING signal_id`,
          [scope, sourceId, signals],
        );
        const tombstones = await query<{
          signal_id: string;
          source_id: string;
        }>(
          "SELECT signal_id,source_id FROM escalator_signal_tombstone WHERE workspace_id=$1 AND signal_id=ANY($2::text[])",
          [scope, signals],
        );
        if (
          tombstones.length !== signals.length ||
          tombstones.some((row) => row.source_id !== sourceId)
        )
          throw new Error("Invalid retention tombstones");
        const processed = await query(
          "DELETE FROM escalator_detection_processed WHERE workspace_id=$1 AND source_id=$2 AND id=ANY($3::text[]) RETURNING id",
          [scope, sourceId, signals],
        );
        if (processed.length !== signals.length)
          throw new Error("Processed receipt disappeared");
      }
      const jobs = await query(
        `DELETE FROM escalator_job WHERE workspace_id=$1 AND id=ANY($2::text[])
        AND kind IN ('signal.process','probe.execute','metrics.poll') AND state='completed'
        AND lease_token IS NULL AND lease_expires_at IS NULL AND completed_at IS NOT NULL RETURNING id`,
        [scope, jobIds],
      );
      if (jobs.length !== jobIds.length)
        throw new Error("Terminal work changed during pruning");
      let deletedRows = 0,
        deletedBytes = 0;
      for (const kind of ["signal", "probe", "metric"] as const) {
        const ids = rows
          .filter((row) => row.kind === kind)
          .map((row) => row.id);
        if (!ids.length) continue;
        const [table, parent, owner] = {
          signal: ["escalator_signal_event", "source_id", sourceId],
          probe: ["escalator_probe_result", "probe_id", probeId],
          metric: ["escalator_metric_observation", "monitor_id", monitorId],
        }[kind];
        const removed = await query<{ bytes: string }>(
          `DELETE FROM ${table} WHERE workspace_id=$1 AND ${parent}=$2 AND id=ANY($3::text[]) RETURNING payload_bytes::text AS bytes`,
          [scope, owner, ids],
        );
        if (removed.length !== ids.length)
          throw new Error("Replay receipt disappeared");
        deletedRows += removed.length;
        deletedBytes += removed.reduce(
          (sum, row) => sum + Number(row.bytes),
          0,
        );
      }
      return { deletedRows, deletedBytes, retainedBytes: await count() };
    },
  };
}
export class PostgresReplayPruneRepository implements ReplayPruneRepository {
  private readonly foundation: PostgresFoundationRepository;
  constructor(pool: Pool) {
    this.foundation = new PostgresFoundationRepository(pool);
  }
  transaction<T>(
    scope: WorkspaceId,
    sourceId: string,
    work: (tx: ReplayPruneTransaction) => Promise<T>,
  ): Promise<T> {
    opaqueIdSchema.parse(sourceId);
    return this.foundation.withConnection(scope, async (base, db, guard) => {
      await db.query("SET LOCAL statement_timeout = '5s'");
      await db.query("SET LOCAL lock_timeout = '1s'");
      if (!(await postgresSignalStore(db, scope).getSource(sourceId, true)))
        throw new PersistenceError("not_found");
      return work(
        replayPruneTransaction(
          base,
          postgresReplayPruneStore(db, scope, sourceId),
          guard,
        ),
      );
    });
  }
}
