import type { Pool } from "pg";
import {
  replayCoverageQuerySchema,
  replayCoverageSnapshotSchema,
  type ReplayCoverageQuery,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import {
  PersistenceError,
  type ReplayCoverageRepository,
} from "@bitsentry-escalator/features/application";
import { PostgresFoundationRepository } from "./foundation.repository.js";
import { coverageSql } from "./coverage-sql.js";
export class PostgresReplayCoverageRepository implements ReplayCoverageRepository {
  private readonly foundation: PostgresFoundationRepository;
  constructor(pool: Pool) {
    this.foundation = new PostgresFoundationRepository(pool);
  }
  snapshot(scope: WorkspaceId, raw: ReplayCoverageQuery) {
    const query = replayCoverageQuerySchema.parse(raw);
    return this.foundation.withConnection(scope, async (_base, connection) => {
      await connection.query("SET LOCAL statement_timeout = '5s'");
      await connection.query("SET LOCAL lock_timeout = '1s'");
      const result = await connection.query(coverageSql(query.kind), [
        scope,
        query.id,
        query.startAt,
        query.endAt,
      ]);
      if (!result.rows[0]) throw new PersistenceError("not_found");
      return replayCoverageSnapshotSchema.parse(result.rows[0].snapshot);
    });
  }
}
