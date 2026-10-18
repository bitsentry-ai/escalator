import type { Pool } from "pg";
import type { WorkspaceId } from "@bitsentry-escalator/features/contracts";
import {
  signalTransaction,
  probeTransaction,
  type ProbeRepository,
  type ProbeTransaction,
} from "@bitsentry-escalator/features/application";
import { PostgresFoundationRepository } from "./foundation.repository.js";
import { postgresSignalStore } from "./postgres-signals.store.js";
import { postgresProbeStore } from "./postgres-probes.store.js";
export class PostgresProbeRepository implements ProbeRepository {
  private readonly foundation: PostgresFoundationRepository;
  constructor(pool: Pool) {
    this.foundation = new PostgresFoundationRepository(pool);
  }
  transaction<T>(
    scope: WorkspaceId,
    work: (tx: ProbeTransaction) => Promise<T>,
  ): Promise<T> {
    return this.foundation.withConnection(
      scope,
      async (base, connection, guard) => {
        await connection.query("SET LOCAL statement_timeout = '5s'");
        await connection.query("SET LOCAL lock_timeout = '1s'");
        return work(
          probeTransaction(
            signalTransaction(
              base,
              postgresSignalStore(connection, scope),
              guard,
            ),
            postgresProbeStore(connection, scope),
            guard,
          ),
        );
      },
    );
  }
}
