import test from "node:test";
import assert from "node:assert/strict";
import { rulePolicyFactSchema } from "../src/contracts/rule-policy.js";
import { detectionRuleSchema } from "../src/contracts/rules.js";
import { resolveRulePolicy } from "../src/application/rules/policy.js";
const at = "2026-10-07T00:01:00.000Z";
const rule = detectionRuleSchema.parse({
  workspaceId: "org",
  serviceId: "api",
  environmentId: "prod",
  languageVersion: 1,
  selector: { kind: "probe", streamId: "probe", field: "failure" },
  aggregation: "sum",
  windowSeconds: 60,
  stepSeconds: 60,
  minimumSamples: 1,
  trigger: { operator: "gte", value: 1 },
  recovery: { operator: "lt", value: 1 },
  persistenceSeconds: 0,
  recoverySeconds: 0,
  cooldownSeconds: 0,
  severity: "high",
});
function facts() {
  const kinds = ["service", "probe", "signal", "binding", "policy"] as const;
  const ids = ["api", "probe", "source", "binding", "policy"];
  return kinds.map((kind, index) =>
    rulePolicyFactSchema.parse({
      id: String(index + 1),
      workspaceId: "org",
      serviceId: "api",
      kind,
      entityId: ids[index],
      environmentId: kind === "service" || kind === "policy" ? null : "prod",
      sourceId: kind === "probe" ? "source" : null,
      policyId: kind === "binding" ? "policy" : null,
      enabled: true,
      deleted: false,
      recordedAt: "2026-10-07T00:00:00.000Z",
    }),
  );
}
test("recorded source, service and paging enablement resolves a complete policy", () => {
  assert.deepEqual(resolveRulePolicy(rule, at, facts()), {
    known: true,
    enabled: true,
    maintenance: false,
  });
});
test("missing legacy history is unknown, not current enablement", () => {
  assert.deepEqual(resolveRulePolicy(rule, at, facts().slice(1)), {
    known: false,
    enabled: false,
    maintenance: false,
  });
});
test("a recorded disable suppresses despite another component's missing history", () => {
  const rows = facts().slice(1);
  rows[0]!.enabled = false;
  assert.deepEqual(resolveRulePolicy(rule, at, rows), {
    known: true,
    enabled: false,
    maintenance: false,
  });
});
test("facts one microsecond after a decision cannot leak into replay", () => {
  const rows = facts();
  rows[0]!.recordedAt = "2026-10-07T00:01:00.000001Z";
  assert.equal(resolveRulePolicy(rule, at, rows).known, false);
});
test("same-time records use exact sequence IDs above JavaScript's safe integer", () => {
  const rows = facts();
  rows[0]!.id = "9007199254740992";
  rows.push({ ...rows[0]!, id: "9007199254740993", enabled: false });
  assert.equal(resolveRulePolicy(rule, at, rows).enabled, false);
});
test("replayed stream linkage selects its historical source rather than another source", () => {
  const rows = facts();
  rows[2]!.entityId = "different-source";
  assert.equal(resolveRulePolicy(rule, at, rows).known, false);
});
test("policy facts cannot cross tenant, service or environment scope", () => {
  for (const override of [
    { workspaceId: "other" },
    { serviceId: "other" },
    { environmentId: "other" },
  ]) {
    const rows = facts();
    rows[1] = rulePolicyFactSchema.parse({ ...rows[1], ...override });
    assert.throws(() => resolveRulePolicy(rule, at, rows), {
      code: "scope_violation",
    });
  }
});
test("a signal stream can use its source fact once without duplicate metadata", () => {
  const rows = facts().filter((row) => row.kind !== "probe");
  const signal = detectionRuleSchema.parse({
    ...rule,
    selector: { kind: "signal", streamId: "source", field: "events" },
    aggregation: "count",
  });
  assert.equal(resolveRulePolicy(signal, at, rows).enabled, true);
  assert.throws(
    () => resolveRulePolicy(signal, at, [...rows, rows[0]!]),
    /Duplicate policy fact/,
  );
});
