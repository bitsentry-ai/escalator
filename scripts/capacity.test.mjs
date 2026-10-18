import test from "node:test";
import assert from "node:assert/strict";
import { evaluateCapacity } from "./capacity-evaluate.mjs";
import { capacityConfiguration } from "./capacity-snapshot.mjs";
const at = (seconds) =>
  new Date(Date.UTC(2026, 9, 8) + seconds * 1000).toISOString();
const evidence = () => ({
  formatVersion: 1,
  host: "standalone",
  clock: "synchronized_utc",
  commitObservation: "database_commit_timestamp",
  startedAt: at(0),
  endedAt: at(120),
  initialPages: [],
  escalationSteps: [],
});
test("missing dispatches remain misses instead of disappearing from the denominator", () => {
  const value = evidence();
  value.initialPages = [
    {
      incidentId: "incident:one.v1",
      committedAt: at(1),
      firstAttemptAt: at(11),
    },
    { incidentId: "two", committedAt: at(2), firstAttemptAt: null },
  ];
  value.escalationSteps = [
    {
      stepId: "one",
      dueAt: at(20),
      firstAttemptAt: null,
      acknowledgedAt: null,
    },
  ];
  const result = evaluateCapacity(value);
  assert.equal(result.initialDispatch.fractionWithinTenSeconds, 0.5);
  assert.equal(result.initialDispatch.thresholdMet, false);
  assert.equal(result.escalationDispatch.missing, 1);
  assert.equal(result.escalationDispatch.thresholdMet, false);
  assert.equal(result.certifiesCapacityEnvelope, false);
});
test("empty cohorts are unknown and only evidenced pre-due acknowledgements are excluded", () => {
  const value = evidence();
  value.escalationSteps = [
    {
      stepId: "ack",
      dueAt: at(20),
      firstAttemptAt: null,
      acknowledgedAt: at(10),
      ackEvidenceId: "receipt",
    },
  ];
  const result = evaluateCapacity(value);
  assert.equal(result.acknowledgedBeforeDue, 1);
  assert.equal(result.initialDispatch.thresholdMet, null);
  assert.equal(result.escalationDispatch.thresholdMet, null);
  value.escalationSteps[0].acknowledgedAt = at(20);
  assert.equal(evaluateCapacity(value).escalationDispatch.eligible, 1);
  value.escalationSteps[0].acknowledgedAt = at(10);
  delete value.escalationSteps[0].ackEvidenceId;
  assert.throws(() => evaluateCapacity(value));
});
test("duplicate, unfinished and contradictory timing evidence cannot produce a passing result", () => {
  const row = {
    incidentId: "one",
    committedAt: at(10),
    firstAttemptAt: at(11),
  };
  assert.throws(() =>
    evaluateCapacity({ ...evidence(), initialPages: [row, row] }),
  );
  assert.throws(() =>
    evaluateCapacity({
      ...evidence(),
      initialPages: [{ ...row, committedAt: at(119), firstAttemptAt: null }],
    }),
  );
  assert.throws(() =>
    evaluateCapacity({
      ...evidence(),
      initialPages: [{ ...row, firstAttemptAt: at(9) }],
    }),
  );
  assert.throws(() =>
    evaluateCapacity({ ...evidence(), commitObservation: "http_response" }),
  );
});
test("capacity diagnostics never fall back to an application database variable", () => {
  assert.throws(() => capacityConfiguration({ DATABASE_URL: "unused" }));
  assert.throws(() =>
    capacityConfiguration({
      ESCALATOR_CAPACITY_DISPOSABLE: "1",
      ESCALATOR_CAPACITY_HOST: "production",
    }),
  );
});
