import {
  opaqueIdSchema,
  signalSourceSchema,
  signalTokenSchema,
  signalEventSchema,
} from "../../contracts/index.js";
import type { SignalSource } from "../../contracts/index.js";
import {
  PersistenceError,
  type FoundationTransaction,
  type PageRequest,
} from "../ports/persistence.js";
import type { TransactionGuard } from "../ports/transaction-guard.js";
import type { SignalRecordStore, SignalTransaction } from "./ports.js";

export class SignalError extends Error {
  constructor(
    readonly code: "invalid_version" | "identity_change" | "invalid_timestamp",
  ) {
    super(code);
  }
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new PersistenceError("not_found");
  return value;
}
function page(input: PageRequest): void {
  if (
    !Number.isInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100 ||
    (input.after !== undefined &&
      !opaqueIdSchema.safeParse(input.after).success)
  )
    throw new PersistenceError("invalid_page");
}
/** Shared validation and poisoned-transaction handling for every host. */
export function signalTransaction(
  base: FoundationTransaction,
  store: SignalRecordStore,
  guard: TransactionGuard,
): SignalTransaction {
  const scoped = (value: { workspaceId: string }) => {
    if (value.workspaceId !== base.workspaceId)
      throw new PersistenceError("scope_violation");
  };
  const atNow = (at: string) => {
    if (Date.parse(at) !== Date.parse(base.now))
      throw new SignalError("invalid_timestamp");
  };
  async function references(value: SignalSource) {
    required(await base.services.get(value.serviceId));
    required(await base.environments.get(value.environmentId));
    if (
      value.authSecretId !== null &&
      !(await store.hasSecret(value.authSecretId))
    )
      throw new PersistenceError("not_found");
  }
  return {
    ...base,
    currentTime: () => guard.operation(() => store.currentTime()),
    sources: {
      get: (id) =>
        guard.operation(() => store.getSource(opaqueIdSchema.parse(id))),
      list: (input) =>
        guard.operation(() => {
          page(input);
          return store.listSources(input);
        }),
      insert: (input) =>
        guard.operation(async () => {
          const value = signalSourceSchema.parse(input);
          scoped(value);
          if (value.version !== 1) throw new SignalError("invalid_version");
          atNow(value.createdAt);
          atNow(value.updatedAt);
          await references(value);
          await store.insertSource(value);
        }),
      replace: (input, expected) =>
        guard.operation(async () => {
          const value = signalSourceSchema.parse(input);
          scoped(value);
          if (
            !Number.isSafeInteger(expected) ||
            expected < 1 ||
            value.version !== expected + 1
          )
            throw new SignalError("invalid_version");
          const current = required(await store.getSource(value.id));
          if (current.version !== expected) return false;
          for (const key of [
            "kind",
            "serviceId",
            "environmentId",
            "createdAt",
          ] as const)
            if (value[key] !== current[key])
              throw new SignalError("identity_change");
          atNow(value.updatedAt);
          await references(value);
          return store.replaceSource(value, expected);
        }),
    },
    tokens: {
      getByHash: (hash) =>
        guard.operation(() =>
          store.getTokenByHash(signalTokenSchema.shape.tokenHash.parse(hash)),
        ),
      insert: (input) =>
        guard.operation(async () => {
          const value = signalTokenSchema.parse(input);
          scoped(value);
          atNow(value.createdAt);
          if (value.revokedAt !== null)
            throw new SignalError("invalid_timestamp");
          required(await store.getSource(value.sourceId));
          await store.insertToken(value);
        }),
      revoke: (id) =>
        guard.operation(async () => {
          opaqueIdSchema.parse(id);
          const token = await store.getToken(id);
          if (!token) return false;
          required(await store.getSource(token.sourceId));
          return store.revokeToken(id, await store.currentTime());
        }),
    },
    signals: {
      get: (id) =>
        guard.operation(() => store.getSignal(opaqueIdSchema.parse(id))),
      insert: (input) =>
        guard.operation(async () => {
          const value = signalEventSchema.parse(input);
          scoped(value);
          atNow(value.receivedAt);
          const source = required(await store.getSource(value.sourceId));
          if (
            source.serviceId !== value.serviceId ||
            source.environmentId !== value.environmentId
          )
            throw new PersistenceError("scope_violation");
          return store.insertSignal(value);
        }),
    },
  };
}
