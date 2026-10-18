import test from "node:test";
import assert from "node:assert/strict";
import { validateInvestigationTrace } from "../src/investigation/orchestration/claims.js";
import { investigationFixture } from "./fixtures/investigation.js";
function fixture() {
  const { claim, result } = investigationFixture();
  return {
    claim,
    event: {
      sequence: 0,
      at: result.report.startedAt,
      kind: "started",
      evidenceIds: [] as string[],
      usage: { ...result.report.usage, traceEvents: 1 },
    },
  };
}
test("trace validation detaches bounded metadata", () => {
  const { claim, event } = fixture();
  const saved = validateInvestigationTrace(claim, event);
  event.evidenceIds.push("later");
  assert.deepEqual(saved.evidenceIds, []);
});
test("trace rejects raw payload fields and invalid timestamps", () => {
  const { claim, event } = fixture();
  for (const extra of [
    { prompt: "secret" },
    { at: "yesterday" },
    { kind: "execute_shell" },
  ])
    assert.throws(() =>
      validateInvestigationTrace(claim, { ...event, ...extra }),
    );
});
test("trace sequence must fit captured limit and cumulative usage", () => {
  const { claim, event } = fixture();
  assert.throws(() =>
    validateInvestigationTrace(claim, { ...event, sequence: 1 }),
  );
  assert.throws(() =>
    validateInvestigationTrace(claim, {
      ...event,
      sequence: 8,
      usage: { ...event.usage, traceEvents: 9 },
    }),
  );
});
test("trace rejects excess usage and repeated evidence IDs", () => {
  const { claim, event } = fixture();
  assert.throws(() =>
    validateInvestigationTrace(claim, {
      ...event,
      usage: { ...event.usage, modelCalls: 2 },
    }),
  );
  assert.throws(() =>
    validateInvestigationTrace(claim, { ...event, evidenceIds: ["a", "a"] }),
  );
});
