import type {
  WorkspaceId,
  ReplayRetentionPolicy,
} from "../../src/contracts/index.js";
import { PersistenceError } from "../../src/application/ports/persistence.js";
import type {
  RetentionPolicyRepository,
  RetentionPolicyTransaction,
} from "../../src/application/retention/policy-management.js";
import { retentionPolicyTransaction } from "../../src/application/retention/policy-transaction.js";
import { MemoryFoundationRepository } from "./memory.js";
export class MemoryRetentionPolicyRepository implements RetentionPolicyRepository {
  readonly foundation = new MemoryFoundationRepository({
    now: () => new Date("2026-10-03T00:00:00.000Z"),
  });
  transaction<T>(
    scope: WorkspaceId,
    work: (tx: RetentionPolicyTransaction) => Promise<T>,
  ): Promise<T> {
    return this.foundation.withExtensions(
      scope,
      async (base, extensions, guard) => {
        const rows = (extensions.retentionPolicies ??=
          []) as ReplayRetentionPolicy[];
        return work(
          retentionPolicyTransaction(
            base,
            {
              get: async () =>
                structuredClone(rows.find((row) => row.workspaceId === scope)),
              put: async (value, expected) => {
                if (!(await base.workspace.get()))
                  throw new PersistenceError("not_found");
                const index = rows.findIndex(
                  (row) => row.workspaceId === scope,
                );
                if ((rows[index]?.version ?? null) !== expected) return false;
                if (index < 0) rows.push(structuredClone(value));
                else rows[index] = structuredClone(value);
                return true;
              },
            },
            guard,
          ),
        );
      },
    );
  }
}
