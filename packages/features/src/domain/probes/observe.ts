import {
  probeSchema,
  probeResultSchema,
  probeStateSchema,
  type Probe,
  type ProbeResult,
  type ProbeState,
} from "../../contracts/probes.js";
/** Unknown telemetry can never clear an active failure. Results are fenced by version and time. */
export function observeProbe(
  probe: Probe,
  current: ProbeState | undefined,
  result: ProbeResult,
):
  | { state: ProbeState; signal: "active" | "recovered" | null }
  | { ignored: true } {
  probeSchema.parse(probe);
  probeResultSchema.parse(result);
  if (probe.workspaceId !== result.workspaceId || probe.id !== result.probeId)
    throw new Error("Probe result scope differs");
  if (current) {
    probeStateSchema.parse(current);
    if (
      current.workspaceId !== probe.workspaceId ||
      current.probeId !== probe.id
    )
      throw new Error("Probe state scope differs");
  }
  if (
    !probe.enabled ||
    result.probeVersion !== probe.version ||
    (current &&
      (current.probeVersion > probe.version ||
        current.lastResultId === result.id ||
        Date.parse(result.observedAt) <= Date.parse(current.lastObservedAt)))
  )
    return { ignored: true };
  // A configuration edit restarts consecutive counters but does not manufacture recovery.
  const previous =
    current?.probeVersion === probe.version ? current : undefined;
  const state: ProbeState = {
    probeId: probe.id,
    workspaceId: probe.workspaceId,
    probeVersion: probe.version,
    lastResultId: result.id,
    lastObservedAt: result.observedAt,
    active: current?.active ?? false,
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
  };
  let signal: "active" | "recovered" | null = null;
  if (result.outcome === "failed") {
    state.consecutiveFailures = Math.min(
      probe.failureThreshold,
      (previous?.consecutiveFailures ?? 0) + 1,
    );
    if (state.consecutiveFailures >= probe.failureThreshold) {
      state.active = true;
      if (!current?.active) signal = "active";
    }
  } else if (result.outcome === "healthy") {
    state.consecutiveSuccesses = Math.min(
      probe.recoveryThreshold,
      (previous?.consecutiveSuccesses ?? 0) + 1,
    );
    if (state.consecutiveSuccesses >= probe.recoveryThreshold) {
      state.active = false;
      if (current?.active) signal = "recovered";
    }
  }
  return { state: probeStateSchema.parse(state), signal };
}
