import { z } from "zod";
import {
  rulePolicyFactSchema,
  type RulePolicyFact,
} from "../../contracts/rule-policy.js";
import {
  detectionRuleSchema,
  type DetectionRule,
} from "../../contracts/rules.js";
import { utcTimestampSchema } from "../../contracts/entities.js";
import { compareUtcTimestamps } from "../../contracts/timestamps.js";
import { PersistenceError } from "../ports/persistence.js";
import { compareBigInts } from "../../contracts/ordering.js";
/** Resolve only recorded policy. Today's settings and unknown legacy intervals
 * never become historical enablement. No host currently exposes maintenance;
 * maintenance=false describes that actual policy, not a guessed past window.
 */
export function resolveRulePolicy(
  rawRule: DetectionRule,
  rawAt: string,
  rawFacts: readonly RulePolicyFact[],
) {
  const rule = detectionRuleSchema.parse(rawRule),
    at = utcTimestampSchema.parse(rawAt);
  const facts = z.array(rulePolicyFactSchema).max(12).parse(rawFacts);
  const ids = new Set<string>();
  for (const row of facts) {
    if (
      row.workspaceId !== rule.workspaceId ||
      row.serviceId !== rule.serviceId ||
      (row.environmentId !== null && row.environmentId !== rule.environmentId)
    )
      throw new PersistenceError("scope_violation");
    if (ids.has(row.id)) throw new Error("Duplicate policy fact");
    ids.add(row.id);
  }
  const visible = facts
    .filter((row) => compareUtcTimestamps(row.recordedAt, at) <= 0)
    .sort(
      (a, b) =>
        compareUtcTimestamps(b.recordedAt, a.recordedAt) ||
        compareBigInts(BigInt(b.id), BigInt(a.id)),
    );
  const find = (kind: RulePolicyFact["kind"], id?: string) =>
    visible.find(
      (row) => row.kind === kind && (id === undefined || row.entityId === id),
    );
  const service = find("service", rule.serviceId),
    stream = find(rule.selector.kind, rule.selector.streamId),
    binding = find("binding");
  // A signal rule reads its stream directly; other rules read the stream's signal source.
  let source = stream;
  if (rule.selector.kind !== "signal")
    source = stream?.sourceId ? find("signal", stream.sourceId) : undefined;
  const policy = binding?.policyId
    ? find("policy", binding.policyId)
    : undefined;
  const required = [service, stream, source];
  // A recorded disable is sufficient to suppress, even when another component's
  // legacy history is missing. Missing history alone never means enabled.
  if (required.some((row) => row && (row.deleted || !row.enabled)))
    return { known: true, enabled: false, maintenance: false };
  if (required.some((row) => !row))
    return { known: false, enabled: false, maintenance: false };
  // Missing/null paging bindings mean paging is off, not unknown source history.
  // Shadow and replay still evaluate the source; active mode additionally gates paging.
  if (!binding || binding.deleted || !binding.enabled || !binding.policyId)
    return {
      known: true,
      enabled: true,
      maintenance: false,
      pagingEnabled: false,
    };
  if (!policy) return { known: false, enabled: false, maintenance: false };
  if (policy.deleted || !policy.enabled)
    return {
      known: true,
      enabled: true,
      maintenance: false,
      pagingEnabled: false,
    };
  return { known: true, enabled: true, maintenance: false };
}
