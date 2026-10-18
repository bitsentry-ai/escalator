import test from "node:test";
import assert from "node:assert/strict";
import { detectionRuleSchema } from "../src/contracts/rules.js";
import {
  ruleHistorySnapshotSchema,
  ruleHistoryQuerySchema,
} from "../src/contracts/rule-history.js";
import { ruleWindowFromHistory } from "../src/application/rules/history-window.js";
import { readRuleHistoryWindow } from "../src/application/rules/history-reader.js";
import { evaluateRuleWindow } from "../src/domain/rules/evaluate.js";
import { selectPeriodicCoverage } from "../src/application/retention/coverage.js";
const at = (minute: number) =>
  new Date(Date.parse("2026-10-07T00:00:00Z") + minute * 60000).toISOString();
const scope = { workspaceId: "org", serviceId: "api", environmentId: "prod" };
const hash = "a".repeat(64);
const rule = () =>
  detectionRuleSchema.parse({
    languageVersion: 1,
    ...scope,
    selector: { kind: "probe", streamId: "probe", field: "failure" },
    aggregation: "maximum",
    windowSeconds: 60,
    stepSeconds: 60,
    collectionDelaySeconds: 60,
    minimumSamples: 1,
    trigger: { operator: "gte", value: 1 },
    recovery: { operator: "lt", value: 1 },
    persistenceSeconds: 0,
    recoverySeconds: 0,
    cooldownSeconds: 0,
    severity: "high",
  });
const history = () =>
  ruleHistorySnapshotSchema.parse({
    ...scope,
    kind: "probe",
    streamId: "probe",
    snapshotAt: at(4),
    startAt: at(1),
    endAt: at(2),
    visibleAt: at(3),
    complete: true,
    configurations: [
      {
        version: 1,
        effectiveAt: at(0),
        recordedAt: at(0),
        enabled: true,
        anchorAt: at(0),
        stepSeconds: 60,
        measurementHash: hash,
      },
    ],
    receipts: [
      {
        version: 1,
        sample: {
          ...scope,
          id: "receipt",
          kind: "probe",
          streamId: "probe",
          slotAt: at(2),
          observedAt: at(2.1),
          receivedAt: at(2.2),
          usable: true,
          success: false,
          durationMs: 6000,
        },
      },
    ],
  });
const project = (data = history()) =>
  ruleWindowFromHistory(rule(), at(3), data, hash);

test("retained endpoint receipt is included with unchanged real timestamps", () => {
  const data = history(),
    copy = structuredClone(data);
  const window = project(data);
  assert.equal(window.coverage, "complete");
  assert.deepEqual(
    window.samples,
    data.receipts.map((row) => row.sample),
  );
  assert.equal(evaluateRuleWindow(rule(), window).state, "trigger");
  assert.deepEqual(data, copy);
});
test("original phase-offset probe schedule certifies one rule bin", () => {
  const data = history();
  data.configurations[0]!.anchorAt = at(0.2);
  const sample = data.receipts[0]!.sample;
  assert.equal(sample.kind, "probe");
  if (sample.kind !== "probe") throw new Error("fixture");
  sample.slotAt = at(1.2);
  sample.observedAt = at(1.3);
  sample.receivedAt = at(1.4);
  assert.equal(project(data).coverage, "complete");
});
test("missing, late, disabled, and unusable evidence never becomes complete coverage", () => {
  for (const mutate of [
    (data: ReturnType<typeof history>) => {
      data.receipts = [];
    },
    (data: ReturnType<typeof history>) => {
      data.receipts[0]!.sample.receivedAt = at(3.1);
    },
    (data: ReturnType<typeof history>) => {
      data.configurations[0]!.enabled = false;
    },
    (data: ReturnType<typeof history>) => {
      const sample = data.receipts[0]!.sample;
      if (sample.kind !== "signal") sample.usable = false;
    },
  ]) {
    const data = history();
    mutate(data);
    assert.notEqual(project(data).coverage, "complete");
    assert.equal(
      evaluateRuleWindow(rule(), project(data)).state,
      "insufficient_data",
    );
  }
});
test("newer unusable receipt wins over earlier usable receipt for the same slot", () => {
  const data = history(),
    newer = structuredClone(data.receipts[0]!);
  newer.sample.id = "newer";
  newer.sample.receivedAt = at(2.3);
  if (newer.sample.kind !== "signal") newer.sample.usable = false;
  data.receipts.push(newer);
  const window = project(data);
  assert.equal(window.coverage, "gaps");
  assert.deepEqual(window.samples, []);
});
test("unknown schedule, revision, availability or changed measurement cannot prove history", () => {
  for (const mutate of [
    (data: ReturnType<typeof history>) => {
      data.receipts[0]!.version = null;
    },
    (data: ReturnType<typeof history>) => {
      const sample = data.receipts[0]!.sample;
      if (sample.kind !== "signal") sample.slotAt = null;
    },
    (data: ReturnType<typeof history>) => {
      data.configurations[0]!.recordedAt = null;
    },
    (data: ReturnType<typeof history>) => {
      data.configurations[0]!.recordedAt = at(3.1);
    },
    (data: ReturnType<typeof history>) => {
      data.configurations[0]!.measurementHash = "b".repeat(64);
    },
    (data: ReturnType<typeof history>) => {
      data.configurations[0]!.stepSeconds = 120;
    },
  ]) {
    const data = history();
    mutate(data);
    assert.notEqual(project(data).coverage, "complete");
  }
});
test("scope, window, capture cutoff and duplicate receipt identity are checked", () => {
  for (const mutate of [
    (data: ReturnType<typeof history>) => {
      data.streamId = "other";
    },
    (data: ReturnType<typeof history>) => {
      data.receipts[0]!.sample.environmentId =
        "other" as typeof data.environmentId;
    },
    (data: ReturnType<typeof history>) => {
      data.startAt = at(0);
    },
    (data: ReturnType<typeof history>) => {
      data.visibleAt = at(4);
    },
    (data: ReturnType<typeof history>) => {
      data.snapshotAt = at(2);
    },
    (data: ReturnType<typeof history>) => {
      data.receipts.push(structuredClone(data.receipts[0]!));
    },
  ]) {
    const data = history();
    mutate(data);
    assert.throws(() => project(data));
  }
});
test("truncation, impossible chronology and expired probe bucket stay inconclusive", () => {
  const truncated = history();
  truncated.complete = false;
  assert.equal(
    evaluateRuleWindow(rule(), project(truncated)).reason,
    "incomplete_read",
  );
  for (const observedAt of [at(1.9), at(3)]) {
    const data = history();
    data.receipts[0]!.sample.observedAt = observedAt;
    assert.notEqual(project(data).coverage, "complete");
  }
});
test("history query is scoped, bounded and shared between live and simulated reads", async () => {
  let calls = 0;
  const repository = {
    snapshot: async (workspaceId: typeof scope.workspaceId, query: unknown) => {
      calls++;
      assert.equal(workspaceId, "org");
      assert.deepEqual(ruleHistoryQuerySchema.parse(query), {
        serviceId: "api",
        environmentId: "prod",
        kind: "probe",
        streamId: "probe",
        startAt: at(1),
        endAt: at(2),
        visibleAt: at(3),
      });
      return history();
    },
  };
  const live = await readRuleHistoryWindow(repository, rule(), at(3), hash);
  const replay = await readRuleHistoryWindow(repository, rule(), at(3), hash);
  assert.deepEqual(live, replay);
  assert.equal(calls, 2);
  assert.deepEqual(
    evaluateRuleWindow(rule(), live),
    evaluateRuleWindow(rule(), replay),
  );
  assert.equal(
    ruleHistoryQuerySchema.safeParse({
      serviceId: "api",
      environmentId: "prod",
      kind: "probe",
      streamId: "probe",
      startAt: at(0),
      endAt: at(1441),
      visibleAt: at(1441),
    }).success,
    false,
  );
});
test("right-closed coverage does not advance the evidence cutoff; old half-open default remains", () => {
  const sample = {
    id: "r",
    version: 1,
    slotAt: at(1),
    observedAt: at(1),
    receivedAt: at(1),
    usable: true,
  };
  const input = {
    workspaceId: history().workspaceId,
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
    samples: [sample],
  };
  assert.deepEqual(selectPeriodicCoverage(input).samples, []);
  assert.equal(
    selectPeriodicCoverage(input, { endInclusive: true }).samples[0]?.id,
    "r",
  );
  input.samples[0]!.receivedAt = new Date(Date.parse(at(1)) + 1).toISOString();
  assert.deepEqual(
    selectPeriodicCoverage(input, { endInclusive: true }).samples,
    [],
  );
});
test("signal history cannot be promoted to a rule without continuity coverage", () => {
  assert.throws(
    () =>
      ruleWindowFromHistory(
        {
          ...rule(),
          selector: { kind: "signal", streamId: "source", field: "events" },
          aggregation: "count",
        },
        at(3),
        history(),
        hash,
      ),
    /Signal rules are unavailable/,
  );
});
