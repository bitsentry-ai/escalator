import test from "node:test";
import assert from "node:assert/strict";
import { at } from "./conformance/rule-backtest-fixture.js";
import { proposalCapture as capture } from "./conformance/proposal-fixture.js";
import { createHash } from "node:crypto";
import { deriveCandidateReplay } from "../src/application/rules/candidate-replay.js";
import { deriveHeldOutReplay } from "../src/application/rules/held-out.js";

test("longer candidate lookbacks use only the captured decision interval", () => {
  const source = capture(),
    candidate = {
      ...source.snapshot.version,
      id: "new",
      definition: { ...source.snapshot.version.definition, windowSeconds: 300 },
    };
  const result = deriveCandidateReplay(source, candidate);
  assert.equal(result.snapshot.firstDecisionAt, at(5));
  assert.equal(result.snapshot.lastDecisionAt, at(10));
  assert.equal(result.snapshot.retained?.history.startAt, at(0));
  assert.equal(result.snapshot.complete, false);
  assert.equal(
    result.snapshot.candidateEvaluation?.sourceInputHash,
    source.inputHash,
  );
  assert.equal(
    result.snapshot.candidateEvaluation?.candidateHash,
    createHash("sha256").update(JSON.stringify(candidate)).digest("hex"),
  );
  assert.equal(
    result.inputHash,
    createHash("sha256").update(JSON.stringify(result.snapshot)).digest("hex"),
  );
  assert.equal(source.snapshot.firstDecisionAt, at(1));
});
test("derived captures cannot become a fresh training or held-out source", () => {
  const source = capture(),
    candidate = { ...source.snapshot.version, id: "new" },
    result = deriveCandidateReplay(source, candidate);
  assert.throws(
    () => deriveCandidateReplay(result, { ...candidate, id: "again" }),
    /original/,
  );
  assert.throws(
    () => deriveHeldOutReplay(result, { ...candidate, id: "again" }),
    /original/,
  );
  assert.throws(
    () => deriveCandidateReplay(source, source.snapshot.version),
    /fixed field/,
  );
  assert.throws(
    () =>
      deriveCandidateReplay(
        { ...source, inputHash: "0".repeat(64) },
        candidate,
      ),
    /intact/,
  );
});
test("a lookback longer than all retained history is unavailable, never invented", () => {
  const source = capture(),
    candidate = {
      ...source.snapshot.version,
      id: "new",
      definition: {
        ...source.snapshot.version.definition,
        windowSeconds: 3600,
      },
    };
  assert.throws(
    () => deriveCandidateReplay(source, candidate),
    /no captured decision window/,
  );
});
