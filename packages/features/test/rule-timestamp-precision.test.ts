import test from "node:test";
import assert from "node:assert/strict";
import {
  compareUtcTimestamps,
  ceilTimestampMilliseconds,
} from "../src/contracts/timestamps.js";
import {
  detectionRuleSchema,
  ruleSampleSchema,
} from "../src/contracts/rules.js";
import { ruleReplaySnapshotSchema } from "../src/contracts/rule-replay.js";
import { evaluateRuleWindow } from "../src/domain/rules/evaluate.js";
import { advanceRuleDecision } from "../src/domain/rules/advance.js";
import { replayRuleWindows } from "../src/application/rules/replay.js";
import {
  selectPeriodicCoverage,
  eventCoverage,
} from "../src/application/retention/coverage.js";
const at = (minute: number) =>
  new Date(Date.parse("2026-10-07T00:00:00Z") + minute * 60000).toISOString();
const micro = (minute: number, fraction = "000001") =>
  at(minute).replace("000Z", `${fraction}Z`);
const scope = { workspaceId: "org", serviceId: "api", environmentId: "prod" };
const rule = detectionRuleSchema.parse({
  ...scope,
  languageVersion: 1,
  selector: { kind: "probe", streamId: "probe", field: "failure" },
  aggregation: "maximum",
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
const sample = () =>
  ruleSampleSchema.parse({
    ...scope,
    kind: "probe",
    streamId: "probe",
    id: "sample",
    slotAt: at(1),
    observedAt: at(1),
    receivedAt: micro(1),
    usable: true,
    success: false,
    durationMs: 1,
  });
function snapshot() {
  return ruleReplaySnapshotSchema.parse({
    snapshotId: "snapshot",
    snapshotAt: at(2),
    version: { id: "rule", revision: 1, definition: rule },
    firstDecisionAt: at(1),
    lastDecisionAt: at(1),
    complete: true,
    samples: [sample()],
    coverage: [
      { startAt: at(0), endAt: at(2), recordedAt: at(0), state: "complete" },
    ],
    policies: [
      {
        startAt: at(0),
        endAt: at(2),
        recordedAt: at(0),
        enabled: true,
        maintenance: false,
      },
    ],
  });
}
const replay = (input = snapshot()) =>
  replayRuleWindows(input, null, { maxDecisions: 10, maxSampleVisits: 10 });
test("timestamp ordering preserves decimal precision and equivalent zero padding", () => {
  assert.equal(compareUtcTimestamps(micro(1), at(1)), 1);
  assert.equal(
    compareUtcTimestamps(micro(1, "000100"), micro(1, "000200")),
    -1,
  );
  assert.equal(compareUtcTimestamps(micro(1, "000000000"), at(1)), 0);
  assert.equal(compareUtcTimestamps(micro(1, "000000001"), at(1)), 1);
  assert.equal(ceilTimestampMilliseconds(micro(1)), Date.parse(at(1)) + 1);
  assert.equal(ceilTimestampMilliseconds("1969-12-31T23:59:59.999999Z"), 0);
});
test("a receipt one microsecond after the decision cannot trigger live or replay", () => {
  const data = sample(),
    original = structuredClone(data);
  const result = evaluateRuleWindow(rule, {
    decisionAt: at(1),
    complete: true,
    coverage: "complete",
    samples: [data],
  });
  assert.equal(result.state, "insufficient_data");
  assert.equal(result.lateCount, 1);
  assert.equal(replay().decisions[0]!.action, "none");
  assert.equal(replay().decisions[0]!.verdict!.lateCount, 1);
  assert.deepEqual(data, original);
  assert.equal(
    evaluateRuleWindow(
      { ...rule, collectionDelaySeconds: 60 },
      {
        decisionAt: at(2),
        complete: true,
        coverage: "complete",
        samples: [data],
      },
    ).state,
    "trigger",
  );
});
test("slots just after a boundary belong to the following right-closed bin", () => {
  const data = sample();
  if (data.kind !== "probe") throw new Error("fixture");
  data.slotAt = micro(1);
  data.observedAt = micro(1);
  data.receivedAt = micro(1);
  const window = {
    decisionAt: at(1),
    complete: true,
    coverage: "complete" as const,
    samples: [data],
  };
  assert.equal(evaluateRuleWindow(rule, window).state, "insufficient_data");
  assert.equal(
    evaluateRuleWindow(rule, { ...window, decisionAt: at(2) }).state,
    "trigger",
  );
});
test("sub-millisecond decision times cannot masquerade as aligned minutes", () => {
  const window = {
    decisionAt: micro(1),
    complete: true,
    coverage: "complete" as const,
    samples: [],
  };
  assert.equal(evaluateRuleWindow(rule, window).reason, "unaligned_window");
  assert.throws(
    () =>
      advanceRuleDecision({ id: "rule", revision: 1, definition: rule }, null, {
        window,
        enabled: true,
        maintenance: false,
      }),
    /not step aligned/,
  );
  assert.equal(
    ruleReplaySnapshotSchema.safeParse({
      ...snapshot(),
      firstDecisionAt: micro(1),
    }).success,
    false,
  );
});
test("snapshot capture and policy availability keep original precision", () => {
  assert.equal(
    ruleReplaySnapshotSchema.safeParse({ ...snapshot(), snapshotAt: at(1) })
      .success,
    false,
  );
  for (const kind of ["policies", "coverage"] as const) {
    const data = snapshot();
    data.samples[0]!.receivedAt = at(1);
    data[kind][0]!.recordedAt = micro(1);
    assert.equal(replay(data).decisions[0]!.action, "none");
  }
  const futurePolicy = snapshot();
  futurePolicy.samples[0]!.receivedAt = at(1);
  futurePolicy.policies[0]!.startAt = micro(1);
  assert.equal(replay(futurePolicy).decisions[0]!.action, "none");
  futurePolicy.policies[0]!.startAt = at(0);
  futurePolicy.policies[0]!.endAt = micro(1);
  assert.equal(replay(futurePolicy).decisions[0]!.action, "opened");
});
test("newest unusable receipt wins even when timestamps differ by less than a millisecond", () => {
  const input = {
    workspaceId: rule.workspaceId,
    streamId: "probe",
    startAt: at(1),
    endAt: at(2),
    visibleAt: at(2),
    complete: true,
    segments: [
      {
        startAt: at(0),
        endAt: at(3),
        version: 1,
        recordedAt: at(0),
        enabled: true,
        anchorAt: at(0),
        stepSeconds: 60,
      },
    ],
    samples: [
      {
        id: "z-old-healthy",
        version: 1,
        slotAt: at(1),
        observedAt: at(1),
        receivedAt: micro(1, "000100"),
        usable: true,
      },
      {
        id: "a-new-unusable",
        version: 1,
        slotAt: at(1),
        observedAt: at(1),
        receivedAt: micro(1, "000200"),
        usable: false,
      },
    ],
  };
  const result = selectPeriodicCoverage(input);
  assert.equal(result.report.availableSlots, 0);
  assert.equal(result.report.gaps[0]!.reason, "unusable");
  assert.deepEqual(result.samples, []);
});
test("coverage receipt/configuration visibility excludes sub-millisecond future knowledge", () => {
  const input = {
    workspaceId: rule.workspaceId,
    streamId: "probe",
    startAt: at(0),
    endAt: at(1),
    visibleAt: at(1),
    complete: true,
    segments: [
      {
        startAt: at(0),
        endAt: at(2),
        version: 1,
        recordedAt: at(0),
        enabled: true,
        anchorAt: at(0),
        stepSeconds: 60,
      },
    ],
    samples: [
      {
        id: "r",
        version: 1,
        slotAt: at(1),
        observedAt: at(1),
        receivedAt: micro(1),
        usable: true,
      },
    ],
  };
  assert.equal(
    selectPeriodicCoverage(input, { endInclusive: true }).report.gaps[0]!
      .reason,
    "late",
  );
  input.segments[0]!.recordedAt = micro(1);
  assert.equal(
    selectPeriodicCoverage(input, { endInclusive: true }).report.gaps[0]!
      .reason,
    "configuration_unavailable",
  );
  assert.equal(
    eventCoverage({
      workspaceId: rule.workspaceId,
      streamId: "source",
      startAt: at(0),
      endAt: at(1),
      visibleAt: at(1),
      complete: true,
      events: [{ id: "event", observedAt: at(0.5), receivedAt: micro(1) }],
    }).lateCount,
    1,
  );
});
