import type { Pool } from "pg";
import {
  replayRetentionPolicySchema,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import {
  retentionPolicyTransaction,
  type RetentionPolicyRepository,
  type RetentionPolicyTransaction,
} from "@bitsentry-escalator/features/application";
import { PostgresFoundationRepository } from "./foundation.repository.js";
type Row = { days: number; maxBytes: string; version: string; updatedAt: Date };
export class PostgresRetentionPolicyRepository implements RetentionPolicyRepository {
  private readonly foundation: PostgresFoundationRepository;
  constructor(pool: Pool) {
    this.foundation = new PostgresFoundationRepository(pool);
  }
  transaction<T>(
    scope: WorkspaceId,
    work: (tx: RetentionPolicyTransaction) => Promise<T>,
  ): Promise<T> {
    return this.foundation.withConnection(scope, async (base, db, guard) => {
      await db.query("SET LOCAL statement_timeout = '5s'");
      await db.query("SET LOCAL lock_timeout = '1s'");
      return work(
        retentionPolicyTransaction(
          base,
          {
            get: async () => {
              const { rows } = await db.query<Row>(
                'SELECT days,max_bytes AS "maxBytes",version,updated_at AS "updatedAt" FROM escalator_retention_policy WHERE workspace_id=$1',
                [scope],
              );
              const row = rows[0];
              return row
                ? replayRetentionPolicySchema.parse({
                    workspaceId: scope,
                    days: row.days,
                    maxBytes: Number(row.maxBytes),
                    version: Number(row.version),
                    updatedAt: row.updatedAt.toISOString(),
                  })
                : undefined;
            },
            put: async (policy, expected) => {
              const locked = await db.query(
                "SELECT workspace_id FROM escalator_replay_usage WHERE workspace_id=$1 FOR UPDATE",
                [scope],
              );
              if (locked.rowCount !== 1)
                throw new Error("Replay accounting row unavailable");
              const values = [
                scope,
                policy.days,
                BigInt(policy.maxBytes),
                BigInt(policy.version),
                policy.updatedAt,
              ];
              const result =
                expected === null
                  ? await db.query(
                      "INSERT INTO escalator_retention_policy(workspace_id,days,max_bytes,version,updated_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id) DO NOTHING",
                      values,
                    )
                  : await db.query(
                      "UPDATE escalator_retention_policy SET days=$2,max_bytes=$3,version=$4,updated_at=$5 WHERE workspace_id=$1 AND version=$6",
                      [...values, BigInt(expected)],
                    );
              return result.rowCount === 1;
            },
          },
          guard,
        ),
      );
    });
  }
}
