import {
  replayRetentionPolicySchema,
  type ReplayRetentionPolicy,
} from "../../contracts/index.js";
import {
  PersistenceError,
  type FoundationTransaction,
} from "../ports/persistence.js";
import type { TransactionGuard } from "../ports/transaction-guard.js";
import type { RetentionPolicyTransaction } from "./policy-management.js";
export interface RetentionPolicyStore {
  get(): Promise<ReplayRetentionPolicy | undefined>;
  /** Lock workspace accounting before compare-and-swap, without taking any source lock. */
  put(
    policy: ReplayRetentionPolicy,
    expectedVersion: number | null,
  ): Promise<boolean>;
}
export function retentionPolicyTransaction(
  base: FoundationTransaction,
  store: RetentionPolicyStore,
  guard: TransactionGuard,
): RetentionPolicyTransaction {
  const validate = (input: ReplayRetentionPolicy) => {
    const policy = replayRetentionPolicySchema.parse(input);
    if (policy.workspaceId !== base.workspaceId)
      throw new PersistenceError("scope_violation");
    return policy;
  };
  return {
    ...base,
    retentionPolicy: {
      get: () =>
        guard.operation(async () => {
          const value = await store.get();
          return value === undefined ? undefined : validate(value);
        }),
      put: (input, expected) =>
        guard.operation(() => {
          const policy = validate(input);
          if (
            expected !== null &&
            (!Number.isSafeInteger(expected) || expected < 1)
          )
            throw new RangeError("Invalid retention revision");
          if (
            policy.version !== (expected ?? 0) + 1 ||
            policy.updatedAt !== base.now
          )
            throw new RangeError("Invalid retention policy write");
          return store.put(policy, expected);
        }),
    },
  };
}
