import type { RuleReplaySnapshot } from "../../contracts/rule-replay.js";
import type { RulePolicyFact } from "../../contracts/rule-policy.js";
import { compareUtcTimestamps } from "../../contracts/timestamps.js";
import { ruleSampleTime, ruleWindowBounds } from "../../domain/rules/time.js";
import { ruleWindowFromHistory } from "./history-window.js";
import { resolveRulePolicy } from "./policy.js";
/** Build the bounded index once per batch. Facts describe what was recorded at
 * the simulated decision, never current configuration or inferred source health. */
export function retainedReplayReader(snapshot: RuleReplaySnapshot) {
  const retained = snapshot.retained;
  if (!retained) return null;
  const rule = snapshot.version.definition;
  const records = [...retained.history.receipts].sort(
    (a, b) => ruleSampleTime(rule, a.sample) - ruleSampleTime(rule, b.sample),
  );
  const index = new Map<string, RulePolicyFact[]>(),
    ids = new Set<string>();
  const key = (kind: RulePolicyFact["kind"], id: string) =>
    kind + "|" + (kind === "binding" ? "*" : id);
  for (const fact of retained.policyFacts) {
    if (ids.has(fact.id)) throw new Error("Duplicate retained policy fact");
    ids.add(fact.id);
    const k = key(fact.kind, fact.entityId),
      list = index.get(k) ?? [];
    list.push(fact);
    index.set(k, list);
  }
  for (const list of index.values())
    list.sort(
      (a, b) =>
        compareUtcTimestamps(a.recordedAt, b.recordedAt) ||
        (BigInt(a.id) < BigInt(b.id)
          ? -1
          : BigInt(a.id) > BigInt(b.id)
            ? 1
            : 0),
    );
  function factAt(kind: RulePolicyFact["kind"], id: string, at: string) {
    const rows = index.get(key(kind, id)) ?? [];
    let low = 0,
      high = rows.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (compareUtcTimestamps(rows[mid].recordedAt, at) <= 0) low = mid + 1;
      else high = mid;
    }
    return rows[low - 1];
  }
  return {
    samples: records.map((r) => r.sample),
    input(at: string, from: number, to: number) {
      const bounds = ruleWindowBounds(rule, at),
        end = new Date(bounds.end).toISOString();
      const history = {
        ...retained.history,
        startAt: new Date(bounds.start).toISOString(),
        endAt: end,
        visibleAt: at,
        complete: snapshot.complete,
        configurations: retained.history.configurations
          .filter(
            (c) =>
              c.effectiveAt === null ||
              compareUtcTimestamps(c.effectiveAt, end) <= 0,
          )
          .map((c) => ({
            ...c,
            recordedAt:
              c.recordedAt !== null &&
              compareUtcTimestamps(c.recordedAt, at) > 0
                ? null
                : c.recordedAt,
          })),
        receipts: records
          .slice(from, to)
          .filter(
            (r) =>
              compareUtcTimestamps(r.sample.observedAt, at) <= 0 &&
              (r.sample.receivedAt === null ||
                compareUtcTimestamps(r.sample.receivedAt, at) <= 0),
          ),
      };
      const stream = factAt(rule.selector.kind, rule.selector.streamId, at),
        binding = factAt("binding", "", at);
      const facts = [
        factAt("service", rule.serviceId, at),
        stream,
        binding,
        rule.selector.kind !== "signal" && stream?.sourceId
          ? factAt("signal", stream.sourceId, at)
          : undefined,
        binding?.policyId ? factAt("policy", binding.policyId, at) : undefined,
      ].filter((f): f is RulePolicyFact => f !== undefined);
      const policy = retained.policyComplete
        ? resolveRulePolicy(rule, at, facts)
        : { known: false, enabled: false, maintenance: false };
      const window = ruleWindowFromHistory(
        rule,
        at,
        history,
        retained.measurementHash,
      );
      if (!policy.known) window.coverage = "unknown";
      return {
        window,
        enabled: policy.known ? policy.enabled : true,
        maintenance: policy.known && policy.maintenance,
      };
    },
  };
}
