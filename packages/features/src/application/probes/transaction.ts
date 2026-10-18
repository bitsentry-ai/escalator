import {
  probeSchema,
  probeStateSchema,
  probeResultSchema,
  type Probe,
} from "../../contracts/probes.js";
import { opaqueIdSchema } from "../../contracts/identity.js";
import { observeProbe } from "../../domain/probes/observe.js";
import { validateSyntheticProbe } from "../../domain/probes/assertions.js";
import { PersistenceError, type PageRequest } from "../ports/persistence.js";
import type { TransactionGuard } from "../ports/transaction-guard.js";
import type { SignalTransaction } from "../signals/ports.js";
import type { ProbeTransaction, ProbeRecordStore } from "./ports.js";
import { probeScheduleSchema, probeJobId } from "./schedule.js";
export class ProbePersistenceError extends Error {
  constructor(
    readonly code:
      | "invalid_version"
      | "identity_change"
      | "invalid_timestamp"
      | "probe_not_locked"
      | "invalid_transition"
      | "invalid_source"
      | "invalid_schedule",
  ) {
    super(code);
  }
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new PersistenceError("not_found");
  return value;
}
function page(input: PageRequest) {
  if (
    !Number.isInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100 ||
    (input.after !== undefined &&
      !opaqueIdSchema.safeParse(input.after).success)
  )
    throw new PersistenceError("invalid_page");
}
/** Hosts supply scoped SQL only. Validation, lock ordering and poisoned handles are shared. */
export function probeTransaction(
  base: SignalTransaction,
  store: ProbeRecordStore,
  guard: TransactionGuard,
): ProbeTransaction {
  const locked = new Map<string, Probe>();
  const scoped = (value: { workspaceId: string }) => {
    if (value.workspaceId !== base.workspaceId)
      throw new PersistenceError("scope_violation");
  };
  const atNow = (value: string) => {
    if (Date.parse(value) !== Date.parse(base.now))
      throw new ProbePersistenceError("invalid_timestamp");
  };
  const owning = (id: string) => {
    const value = locked.get(id);
    if (!value) throw new ProbePersistenceError("probe_not_locked");
    return value;
  };
  async function lock(id: string) {
    opaqueIdSchema.parse(id);
    const hint = await store.get(id);
    if (!hint) return undefined;
    required(await base.sources.get(hint.sourceId));
    const value = await store.get(id, true);
    if (value) locked.set(id, value);
    return value;
  }
  return {
    ...base,
    probes: {
      get: (id) => guard.operation(() => store.get(opaqueIdSchema.parse(id))),
      lock: (id) => guard.operation(() => lock(id)),
      list: (input) =>
        guard.operation(() => {
          page(input);
          return store.list(input);
        }),
      put: (input, expected) =>
        guard.operation(async () => {
          const value = probeSchema.parse(input);
          scoped(value);
          validateSyntheticProbe(value.config);
          if (
            value.version !== (expected ?? 0) + 1 ||
            (expected !== null &&
              (!Number.isSafeInteger(expected) || expected < 1))
          )
            throw new ProbePersistenceError("invalid_version");
          atNow(value.updatedAt);
          if (expected === null) atNow(value.createdAt);
          const source = required(await base.sources.get(value.sourceId));
          if (
            source.kind !== "probe" ||
            source.serviceId !== value.serviceId ||
            source.environmentId !== value.environmentId
          )
            throw new ProbePersistenceError("invalid_source");
          const current = await store.get(value.id, true);
          if ((current?.version ?? null) !== expected) return false;
          if (current)
            for (const key of [
              "sourceId",
              "serviceId",
              "environmentId",
              "createdAt",
            ] as const)
              if (value[key] !== current[key])
                throw new ProbePersistenceError("identity_change");
          if (
            value.config.authSecretId !== null &&
            (value.enabled ||
              current?.config.authSecretId !== value.config.authSecretId) &&
            !(await store.hasSecret(value.config.authSecretId))
          )
            throw new PersistenceError("not_found");
          const written = await store.put(value, expected);
          if (written) locked.set(value.id, value);
          return written;
        }),
      schedule: (id) =>
        guard.operation(() => store.schedule(opaqueIdSchema.parse(id))),
      putSchedule: (input) =>
        guard.operation(async () => {
          const value = probeScheduleSchema.parse(input);
          scoped(value);
          const probe = owning(value.probeId);
          if (
            value.probeVersion !== probe.version ||
            (value.jobId !== null &&
              (!probe.enabled ||
                value.jobId !==
                  probeJobId(
                    base.workspaceId,
                    probe.id,
                    probe.version,
                    value.dueAt!,
                  )))
          )
            throw new ProbePersistenceError("invalid_schedule");
          await store.putSchedule(value);
        }),
      state: (id) =>
        guard.operation(() => store.state(opaqueIdSchema.parse(id))),
      putState: (input) =>
        guard.operation(async () => {
          const value = probeStateSchema.parse(input);
          scoped(value);
          const probe = owning(value.probeId);
          const result = required(await store.result(value.lastResultId));
          const decision = observeProbe(
            probe,
            await store.state(probe.id),
            result,
          );
          if (
            "ignored" in decision ||
            JSON.stringify(value) !== JSON.stringify(decision.state)
          )
            throw new ProbePersistenceError("invalid_transition");
          await store.putState(value);
        }),
      result: (id) =>
        guard.operation(() => store.result(opaqueIdSchema.parse(id))),
      results: (id, input) =>
        guard.operation(() => {
          opaqueIdSchema.parse(id);
          page(input);
          return store.results(id, input);
        }),
      recordResult: (input) =>
        guard.operation(async () => {
          const value = probeResultSchema.parse(input);
          scoped(value);
          const probe = owning(value.probeId);
          if (value.probeVersion !== probe.version)
            throw new ProbePersistenceError("invalid_version");
          atNow(value.observedAt);
          await store.recordResult(value);
        }),
    },
  };
}
