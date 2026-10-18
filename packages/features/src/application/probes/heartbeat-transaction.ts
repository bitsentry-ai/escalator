import { createHash } from "node:crypto";
import {
  heartbeatSchema,
  heartbeatStateSchema,
  heartbeatReceiptSchema,
  heartbeatGrantSchema,
  type Heartbeat,
  type HeartbeatState,
} from "../../contracts/heartbeat.js";
import { opaqueIdSchema } from "../../contracts/identity.js";
import { PersistenceError, type PageRequest } from "../ports/persistence.js";
import type { TransactionGuard } from "../ports/transaction-guard.js";
import type { SignalTransaction } from "../signals/ports.js";
import type {
  HeartbeatRecordStore,
  HeartbeatTransaction,
} from "./heartbeat-ports.js";
import {
  configureHeartbeat,
  acceptHeartbeat,
  missHeartbeat,
  HeartbeatError,
} from "./heartbeat.js";
export function heartbeatReceiptId(
  scope: string,
  probeId: string,
  eventId: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify(["heartbeat.ping", scope, probeId, eventId]))
    .digest("hex");
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new PersistenceError("not_found");
  return value;
}
export function heartbeatTransaction(
  base: SignalTransaction,
  store: HeartbeatRecordStore,
  guard: TransactionGuard,
): HeartbeatTransaction {
  const locked = new Map<string, Heartbeat>();
  const configured = new Set<string>();
  const accepted = new Map<string, HeartbeatState>();
  const scoped = (value: { workspaceId: string }) => {
    if (value.workspaceId !== base.workspaceId)
      throw new PersistenceError("scope_violation");
  };
  const owning = (id: string) => required(locked.get(id));
  async function lock(id: string) {
    opaqueIdSchema.parse(id);
    const hint = await store.get(id);
    if (!hint) return undefined;
    required(await base.sources.get(hint.sourceId));
    const value = await store.get(id, true);
    if (value) locked.set(id, value);
    return value;
  }
  async function live(at: string) {
    const now = await base.currentTime();
    if (
      Date.parse(at) < Date.parse(base.now) ||
      Date.parse(at) > Date.parse(now)
    )
      throw new HeartbeatError("invalid_state");
    return now;
  }
  return {
    ...base,
    heartbeats: {
      get: (id) => guard.operation(() => store.get(opaqueIdSchema.parse(id))),
      lock: (id) => guard.operation(() => lock(id)),
      list: (input) =>
        guard.operation(() => {
          validatePage(input);
          return store.list(input);
        }),
      put: (input, expected) =>
        guard.operation(async () => {
          const value = heartbeatSchema.parse(input);
          scoped(value);
          if (
            value.version !== (expected ?? 0) + 1 ||
            (expected !== null &&
              (!Number.isSafeInteger(expected) || expected < 1)) ||
            value.updatedAt !== base.now ||
            (expected === null && value.createdAt !== base.now)
          )
            throw new HeartbeatError("invalid_state");
          const source = required(await base.sources.get(value.sourceId));
          if (
            source.kind !== "heartbeat" ||
            source.serviceId !== value.serviceId ||
            source.environmentId !== value.environmentId
          )
            throw new HeartbeatError("invalid_state");
          const current = await store.get(value.id, true);
          if ((current?.version ?? null) !== expected) return false;
          if (current)
            for (const key of [
              "sourceId",
              "serviceId",
              "environmentId",
              "createdAt",
            ] as const)
              if (current[key] !== value[key])
                throw new HeartbeatError("invalid_state");
          if (!(await store.put(value, expected))) return false;
          locked.set(value.id, value);
          configured.add(value.id);
          return true;
        }),
      state: (id) =>
        guard.operation(() => store.state(opaqueIdSchema.parse(id))),
      putState: (input) =>
        guard.operation(async () => {
          const value = heartbeatStateSchema.parse(input);
          scoped(value);
          const probe = owning(value.probeId);
          const old = await store.state(probe.id);
          const expected = configured.has(probe.id)
            ? configureHeartbeat(probe, old, base.now)
            : (accepted.get(probe.id) ??
              (old?.deadlineJobId
                ? missHeartbeat(
                    probe,
                    old,
                    old.deadlineJobId,
                    await base.currentTime(),
                  )
                : undefined));
          if (
            !expected ||
            JSON.stringify(value) !==
              JSON.stringify(heartbeatStateSchema.parse(expected))
          )
            throw new HeartbeatError("invalid_state");
          await store.putState(value);
          configured.delete(probe.id);
          accepted.delete(probe.id);
        }),
      receipt: (id, eventId) =>
        guard.operation(() =>
          store.receipt(
            opaqueIdSchema.parse(id),
            opaqueIdSchema.parse(eventId),
          ),
        ),
      insertReceipt: (input) =>
        guard.operation(async () => {
          const value = heartbeatReceiptSchema.parse(input);
          scoped(value);
          const probe = owning(value.probeId);
          const now = await live(value.acceptedAt);
          const grant = required(await store.grant(value.grantId));
          const source = required(await base.sources.get(probe.sourceId));
          const service = required(await base.services.get(probe.serviceId));
          if (
            grant.probeId !== probe.id ||
            grant.revokedAt !== null ||
            Date.parse(grant.expiresAt) <= Date.parse(now) ||
            !source.enabled ||
            !service.enabled
          )
            throw new HeartbeatError("disabled");
          const old = required(await store.state(probe.id));
          const next = acceptHeartbeat(
            probe,
            old,
            {
              version: 1,
              eventId: value.eventId,
              observedAt: value.observedAt,
            },
            value.acceptedAt,
          );
          if (
            value.id !==
              heartbeatReceiptId(base.workspaceId, probe.id, value.eventId) ||
            value.generation !== next.generation ||
            value.deadlineAt !== next.deadlineAt ||
            accepted.has(probe.id)
          )
            throw new HeartbeatError("invalid_state");
          await store.insertReceipt(value);
          accepted.set(probe.id, next);
        }),
      grants: (id, page) =>
        guard.operation(async () => {
          opaqueIdSchema.parse(id);
          validatePage(page);
          required(await store.get(id));
          return store.grants(id, page);
        }),
      grantByHash: (hash) =>
        guard.operation(() =>
          store.grantByHash(heartbeatGrantSchema.shape.tokenHash.parse(hash)),
        ),
      insertGrant: (input) =>
        guard.operation(async () => {
          const value = heartbeatGrantSchema.parse(input);
          scoped(value);
          owning(value.probeId);
          if (value.createdAt !== base.now || value.revokedAt !== null)
            throw new HeartbeatError("invalid_state");
          await store.insertGrant(value);
        }),
      revokeGrant: (id, grantId) =>
        guard.operation(async () => {
          const probe = owning(opaqueIdSchema.parse(id));
          const grant = await store.grant(opaqueIdSchema.parse(grantId));
          if (!grant || grant.probeId !== probe.id)
            throw new PersistenceError("not_found");
          return store.revokeGrant(grantId, await base.currentTime());
        }),
    },
  };
}
function validatePage(input: PageRequest) {
  if (
    !Number.isInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100 ||
    (input.after !== undefined &&
      !opaqueIdSchema.safeParse(input.after).success)
  )
    throw new PersistenceError("invalid_page");
}
