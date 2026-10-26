import type { HttpProbeConfig, ProbeResult } from "../../contracts/probes.js";
import {
  boundedProbeJson,
  probeJsonValue,
} from "../../contracts/probe-validation.js";
export {
  boundedProbeJson,
  probeJsonValue,
  validateSyntheticProbe,
} from "../../contracts/probe-validation.js";
type JsonAssertion = HttpProbeConfig["assertions"]["json"][number];
function jsonAssertionHolds(assertion: JsonAssertion, value: unknown): boolean {
  if (assertion.operator === "equals") return Object.is(value, assertion.value);
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  return assertion.operator === "gte"
    ? value >= assertion.value
    : value <= assertion.value;
}
export function evaluateProbeResponse(
  config: HttpProbeConfig,
  status: number,
  body: string,
): Pick<ProbeResult, "outcome" | "reason"> {
  const failed = (reason: ProbeResult["reason"]) => ({
    outcome: "failed" as const,
    reason,
  });
  if (!config.assertions.status.includes(status))
    return failed("status_mismatch");
  if (
    config.assertions.contains !== null &&
    !body.includes(config.assertions.contains)
  )
    return failed("body_mismatch");
  if (config.assertions.json.length) {
    let parsed: unknown;
    try {
      parsed = boundedProbeJson(body);
    } catch {
      return failed("invalid_json");
    }
    for (const assertion of config.assertions.json) {
      const value = probeJsonValue(parsed, assertion.path);
      if (!jsonAssertionHolds(assertion, value)) return failed("json_mismatch");
    }
  }
  return { outcome: "healthy", reason: "assertions_passed" };
}
