import { createHash } from "node:crypto";
import {
  heartbeatSchema,
  heartbeatStateSchema,
  heartbeatPingSchema,
  type Heartbeat,
  type HeartbeatState,
  type HeartbeatPing,
} from "../../contracts/heartbeat.js";
import { utcTimestampSchema } from "../../contracts/entities.js";
export class HeartbeatError extends Error {
  constructor(
    readonly code:
      | "disabled"
      | "stale_ping"
      | "invalid_state"
      | "generation_exhausted",
  ) {
    super(code);
  }
}
export function heartbeatDeadlineId(
  scope: string,
  probeId: string,
  version: number,
  generation: number,
  dueAt: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "heartbeat.deadline",
        scope,
        probeId,
        version,
        generation,
        dueAt,
      ]),
    )
    .digest("hex");
}
function nextGeneration(old: HeartbeatState | undefined): number {
  const value = (old?.generation ?? 0) + 1;
  if (!Number.isSafeInteger(value))
    throw new HeartbeatError("generation_exhausted");
  return value;
}
function state(config: Heartbeat, old: HeartbeatState | undefined): void {
  heartbeatSchema.parse(config);
  if (old) {
    heartbeatStateSchema.parse(old);
    if (
      old.workspaceId !== config.workspaceId ||
      old.probeId !== config.id ||
      old.configurationVersion > config.version
    )
      throw new HeartbeatError("invalid_state");
  }
}
/** A configuration change invalidates old jobs but does not claim recovery from an existing miss. */
export function configureHeartbeat(
  config: Heartbeat,
  old: HeartbeatState | undefined,
  now: string,
): HeartbeatState {
  state(config, old);
  utcTimestampSchema.parse(now);
  const generation = nextGeneration(old);
  const dueAt = config.enabled
    ? new Date(
        Date.parse(now) + (config.intervalSeconds + config.graceSeconds) * 1000,
      ).toISOString()
    : null;
  return heartbeatStateSchema.parse({
    workspaceId: config.workspaceId,
    probeId: config.id,
    configurationVersion: config.version,
    generation,
    lastAcceptedAt: old?.lastAcceptedAt ?? null,
    lastObservedAt: old?.lastObservedAt ?? null,
    missedAt: old?.missedAt ?? null,
    deadlineAt: dueAt,
    deadlineJobId: dueAt
      ? heartbeatDeadlineId(
          config.workspaceId,
          config.id,
          config.version,
          generation,
          dueAt,
        )
      : null,
  });
}
/** Duplicate event receipts are handled before this transition; they never extend a deadline. */
export function acceptHeartbeat(
  config: Heartbeat,
  old: HeartbeatState,
  input: HeartbeatPing,
  now: string,
): HeartbeatState {
  state(config, old);
  input = heartbeatPingSchema.parse(input);
  utcTimestampSchema.parse(now);
  if (!config.enabled) throw new HeartbeatError("disabled");
  if (old.configurationVersion !== config.version)
    throw new HeartbeatError("invalid_state");
  const observed = Date.parse(input.observedAt),
    accepted = Date.parse(now);
  if (
    observed < accepted - 300000 ||
    observed > accepted + 60000 ||
    (old.lastObservedAt !== null &&
      observed <= Date.parse(old.lastObservedAt)) ||
    (old.lastAcceptedAt !== null && accepted < Date.parse(old.lastAcceptedAt))
  )
    throw new HeartbeatError("stale_ping");
  const next = configureHeartbeat(config, old, now);
  return {
    ...next,
    lastAcceptedAt: now,
    lastObservedAt: input.observedAt,
    missedAt: null,
  };
}
/** A ping or edit superseding a deadline makes its old miss harmless. */
export function missHeartbeat(
  config: Heartbeat,
  old: HeartbeatState,
  expectedJob: string,
  now: string,
): HeartbeatState | undefined {
  state(config, old);
  utcTimestampSchema.parse(now);
  if (
    !config.enabled ||
    old.configurationVersion !== config.version ||
    old.deadlineJobId !== expectedJob ||
    old.deadlineAt === null ||
    Date.parse(old.deadlineAt) >= Date.parse(now)
  )
    return undefined;
  return {
    ...old,
    missedAt: old.missedAt ?? old.deadlineAt,
    deadlineAt: null,
    deadlineJobId: null,
  };
}
