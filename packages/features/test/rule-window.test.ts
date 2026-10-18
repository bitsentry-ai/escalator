import test from "node:test";
import assert from "node:assert/strict";
import {
  detectionRuleSchema,
  ruleSampleSchema,
  ruleWindowSchema,
  type DetectionRule,
  type RuleWindow,
} from "../src/contracts/rules.js";
import { evaluateRuleWindow } from "../src/domain/rules/evaluate.js";

const scope = {
  workspaceId: "org-one",
  serviceId: "api",
  environmentId: "production",
};
const at = (minute: number) =>
  new Date(Date.parse("2026-10-06T00:00:00Z") + minute * 60000).toISOString();
function rule(): DetectionRule {
  return detectionRuleSchema.parse({
    languageVersion: 1,
    ...scope,
    selector: {
      kind: "metric",
      streamId: "requests",
      field: "error_rate",
      minimumRequests: 100,
    },
    aggregation: "minimum",
    windowSeconds: 180,
    stepSeconds: 60,
    minimumSamples: 3,
    trigger: { operator: "gte", value: 0.05 },
    recovery: { operator: "lt", value: 0.03 },
    persistenceSeconds: 120,
    recoverySeconds: 60,
    cooldownSeconds: 300,
    severity: "high",
  });
}
function window(rates = [0.05, 0.1, 0.2]): RuleWindow {
  return ruleWindowSchema.parse({
    decisionAt: at(3),
    complete: true,
    coverage: "complete",
    samples: rates.map((rate, i) => ({
      ...scope,
      id: `sample-${i}`,
      kind: "metric",
      streamId: "requests",
      observedAt: at(i + 1),
      receivedAt: at(i + 1),
      usable: true,
      requests: 100,
      errors: rate * 100,
    })),
  });
}
test("versioned sustained-floor windows are deterministic, immutable and independent of input order", () => {
  const input = rule(),
    snapshot = window();
  const original = structuredClone({ input, snapshot });
  const expected = {
    evaluatorVersion: 1,
    state: "trigger",
    reason: "trigger",
    value: 0.05,
    sampleCount: 3,
    lateCount: 0,
    retrospectiveCount: 0,
  };
  assert.deepEqual(evaluateRuleWindow(input, snapshot), expected);
  assert.deepEqual(
    evaluateRuleWindow(input, {
      ...snapshot,
      samples: [...snapshot.samples].reverse(),
    }),
    expected,
  );
  assert.deepEqual(
    evaluateRuleWindow(structuredClone(input), structuredClone(snapshot)),
    expected,
  );
  assert.deepEqual({ input, snapshot }, original);
});
test("recovery and the hysteresis band are distinct from a trigger", () => {
  assert.equal(
    evaluateRuleWindow(rule(), window([0, 0.02, 0.02])).state,
    "recovery",
  );
  assert.equal(
    evaluateRuleWindow(rule(), window([0.03, 0.04, 0.04])).state,
    "hold",
  );
  const input = rule();
  input.trigger = { operator: "gt", value: 0.05 };
  assert.equal(
    evaluateRuleWindow(input, window([0.05, 0.05, 0.05])).state,
    "hold",
  );
  input.recovery = { operator: "lte", value: 0.05 };
  assert.equal(
    evaluateRuleWindow(input, window([0.05, 0.05, 0.05])).state,
    "recovery",
  );
});
for (const [name, mutate] of Object.entries({
  sql: (r: Record<string, unknown>) => {
    r.sql = "SELECT * FROM secrets";
  },
  javascript: (r: Record<string, unknown>) => {
    r.evaluate = "process.exit()";
  },
  version: (r: Record<string, unknown>) => {
    r.languageVersion = 2;
  },
  expression: (r: Record<string, unknown>) => {
    r.selector = { kind: "expression", code: "1+1" };
  },
  url: (r: Record<string, unknown>) => {
    r.selector = {
      kind: "probe",
      field: "failure",
      streamId: "https://example.com",
    };
  },
  aggregation: (r: Record<string, unknown>) => {
    r.aggregation = "eval";
  },
  rateSum: (r: Record<string, unknown>) => {
    r.aggregation = "sum";
  },
  overlap: (r: Record<string, unknown>) => {
    r.recovery = { operator: "lte", value: 0.05 };
  },
  rateThreshold: (r: Record<string, unknown>) => {
    r.trigger = { operator: "gt", value: 2 };
  },
  misalignedPersistence: (r: Record<string, unknown>) => {
    r.persistenceSeconds = 1;
  },
  misalignedWindow: (r: Record<string, unknown>) => {
    r.windowSeconds = 181;
  },
  excessiveSamples: (r: Record<string, unknown>) => {
    r.minimumSamples = 4;
  },
  nonfinite: (r: Record<string, unknown>) => {
    r.trigger = { operator: "gt", value: Infinity };
  },
})) {
  test(`language rejects ${name}`, () => {
    const input: Record<string, unknown> = structuredClone(rule());
    mutate(input);
    assert.equal(detectionRuleSchema.safeParse(input).success, false);
    assert.equal(
      evaluateRuleWindow(input as DetectionRule, window()).reason,
      "invalid_input",
    );
  });
}
for (const key of [
  "workspaceId",
  "serviceId",
  "environmentId",
  "streamId",
] as const) {
  test(`mismatched ${key} fails closed even when a sample is outside the window`, () => {
    const snapshot = window();
    const foreign = ruleSampleSchema.parse({
      ...snapshot.samples[0],
      [key]: "other",
      observedAt: at(-1),
    });
    snapshot.samples.push(foreign);
    assert.equal(evaluateRuleWindow(rule(), snapshot).reason, "scope_mismatch");
  });
}
test("incomplete reads and unknown or gapped coverage never clear a rule", () => {
  for (const patch of [
    { complete: false },
    { coverage: "unknown" as const },
    { coverage: "gaps" as const },
  ]) {
    assert.equal(
      evaluateRuleWindow(rule(), { ...window([0, 0, 0]), ...patch }).state,
      "insufficient_data",
    );
  }
});
test("periodic windows require each exact grid slot, not only a minimum count", () => {
  const input = rule();
  input.minimumSamples = 1;
  const snapshot = window();
  snapshot.samples.splice(1, 1);
  assert.equal(evaluateRuleWindow(input, snapshot).reason, "missing_samples");
  snapshot.samples.push({ ...snapshot.samples[0]!, id: "another" });
  assert.equal(
    evaluateRuleWindow(input, snapshot).reason,
    "conflicting_samples",
  );
});
test("duplicate event identities and duplicate periodic slots are rejected", () => {
  const snapshot = window();
  snapshot.samples.push(structuredClone(snapshot.samples[0]!));
  assert.equal(
    evaluateRuleWindow(rule(), snapshot).reason,
    "conflicting_samples",
  );
  snapshot.samples[3]!.observedAt = at(2);
  assert.equal(
    evaluateRuleWindow(rule(), snapshot).reason,
    "conflicting_samples",
  );
});
test("a window excludes its start boundary and samples beyond its decision", () => {
  const snapshot = window();
  snapshot.samples.push(
    { ...snapshot.samples[0]!, id: "before", observedAt: at(0) },
    {
      ...snapshot.samples[0]!,
      id: "after",
      observedAt: at(4),
      receivedAt: at(4),
    },
  );
  assert.deepEqual(
    evaluateRuleWindow(rule(), snapshot),
    evaluateRuleWindow(rule(), window()),
  );
});
test("unaligned timestamps and decision times cannot masquerade as complete periodic coverage", () => {
  const snapshot = window();
  snapshot.samples[1]!.observedAt = new Date(
    Date.parse(at(2)) + 1,
  ).toISOString();
  assert.equal(evaluateRuleWindow(rule(), snapshot).reason, "unaligned_window");
  assert.equal(
    evaluateRuleWindow(rule(), {
      ...window(),
      decisionAt: new Date(Date.parse(at(3)) + 1).toISOString(),
    }).reason,
    "unaligned_window",
  );
});
test("late samples cannot replace missing historical slots", () => {
  const snapshot = window();
  snapshot.samples[1]!.receivedAt = at(4);
  const result = evaluateRuleWindow(rule(), snapshot);
  assert.equal(result.state, "insufficient_data");
  assert.equal(result.lateCount, 1);
  assert.equal(result.sampleCount, 2);
});
test("an additional future receipt does not influence a complete visible window", () => {
  const snapshot = window();
  snapshot.samples.push({
    ...snapshot.samples[0]!,
    id: "future",
    receivedAt: at(4),
  });
  const result = evaluateRuleWindow(rule(), snapshot);
  assert.equal(result.state, "trigger");
  assert.equal(result.value, 0.05);
  assert.equal(result.lateCount, 1);
});
test("unknown availability is reported as retrospective rather than historical proof", () => {
  const snapshot = window();
  snapshot.samples[1]!.receivedAt = null;
  const result = evaluateRuleWindow(rule(), snapshot);
  assert.equal(result.reason, "retrospective_samples");
  assert.equal(result.retrospectiveCount, 1);
});
test("missing denominators, invalid counts, provider errors and low traffic remain unknown", () => {
  for (const patch of [
    { requests: null },
    { errors: null },
    { requests: 0, errors: 0 },
    { requests: 2, errors: 3 },
    { usable: false },
  ]) {
    const snapshot = window();
    snapshot.samples[1] = ruleSampleSchema.parse({
      ...snapshot.samples[1],
      ...patch,
    });
    assert.equal(
      evaluateRuleWindow(rule(), snapshot).state,
      "insufficient_data",
    );
  }
  const input = rule();
  if (input.selector.kind === "metric") input.selector.minimumRequests = 301;
  assert.equal(
    evaluateRuleWindow(input, window()).reason,
    "insufficient_requests",
  );
});
test("numeric overflow cannot produce a valid aggregate", () => {
  const input = rule();
  input.selector = {
    kind: "metric",
    streamId: "requests",
    field: "requests",
    minimumRequests: 1,
  };
  input.aggregation = "sum";
  const snapshot = window();
  snapshot.samples = snapshot.samples.map((s) =>
    ruleSampleSchema.parse({ ...s, requests: Number.MAX_SAFE_INTEGER }),
  );
  assert.equal(evaluateRuleWindow(input, snapshot).reason, "unusable_samples");
});
test("allowed count aggregations use actual per-bin numbers", () => {
  const input = rule();
  input.selector = {
    kind: "metric",
    streamId: "requests",
    field: "errors",
    minimumRequests: 1,
  };
  for (const [aggregation, value] of [
    ["sum", 35],
    ["mean", 35 / 3],
    ["minimum", 5],
    ["maximum", 20],
  ] as const) {
    input.aggregation = aggregation;
    assert.equal(evaluateRuleWindow(input, window()).value, value);
  }
});
test("probe rules evaluate only stored outcomes or durations", () => {
  const input = rule();
  input.selector = { kind: "probe", streamId: "health", field: "failure" };
  input.aggregation = "mean";
  const snapshot = window();
  snapshot.samples = snapshot.samples.map((s, i) =>
    ruleSampleSchema.parse({
      ...scope,
      id: s.id,
      streamId: "health",
      kind: "probe",
      observedAt: s.observedAt,
      receivedAt: s.receivedAt,
      usable: true,
      success: i === 0,
      durationMs: 100 + i * 10,
    }),
  );
  assert.equal(evaluateRuleWindow(input, snapshot).value, 2 / 3);
  input.selector.field = "duration_ms";
  input.aggregation = "maximum";
  assert.equal(evaluateRuleWindow(input, snapshot).value, 120);
  snapshot.samples[0] = ruleSampleSchema.parse({
    ...snapshot.samples[0],
    usable: false,
  });
  assert.equal(evaluateRuleWindow(input, snapshot).reason, "unusable_samples");
});
test("signal rules are rejected until source continuity coverage is supported", () => {
  const input = {
    ...rule(),
    selector: { kind: "signal", streamId: "alerts", field: "events" },
    aggregation: "count",
  };
  assert.equal(detectionRuleSchema.safeParse(input).success, false);
  assert.equal(
    evaluateRuleWindow(input as ReturnType<typeof rule>, window()).reason,
    "invalid_input",
  );
});
