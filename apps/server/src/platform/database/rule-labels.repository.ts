import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { WorkspaceId } from "@bitsentry-escalator/features/contracts";
import {
  withIncidentLabels,
  type IncidentLabelRepository,
  type IncidentLabelTransaction,
} from "@bitsentry-escalator/features/application";
import { PostgresFoundationRepository } from "./foundation.repository.js";
import { postgresRuleLabelStore } from "./postgres-rule-labels.store.js";
export class PostgresRuleLabelRepository implements IncidentLabelRepository {
  private readonly foundation: PostgresFoundationRepository;
  constructor(pool: Pool) {
    this.foundation = new PostgresFoundationRepository(pool);
  }
  transaction<T>(
    scope: WorkspaceId,
    run: (tx: IncidentLabelTransaction) => Promise<T>,
  ): Promise<T> {
    return this.foundation.withConnection(scope, async (base, db, guard) => {
      await db.query("SET LOCAL statement_timeout = '5s'");
      await db.query("SET LOCAL lock_timeout = '1s'");
      return run(
        withIncidentLabels(
          base,
          postgresRuleLabelStore(db, scope),
          guard,
          randomUUID,
        ),
      );
    });
  }
}
