import test from "node:test";
import assert from "node:assert/strict";
import { StandaloneInvestigationDeployment } from "../../src/features/escalator/investigation/deployment.js";
test("investigation execution is disabled and has no implicit egress grant", () => {
  const value = StandaloneInvestigationDeployment.fromJSON(undefined);
  assert.equal(value.enabled, false);
  assert.equal(value.concurrency, 1);
  assert.throws(() => value.policy.endpoint("http://127.0.0.1:11434", "local"));
  assert.equal(value.policy.address("127.0.0.1", "local"), false);
});
test("local model access needs both exact destination and loopback approval", () => {
  const value = StandaloneInvestigationDeployment.fromJSON(
    JSON.stringify({
      enabled: true,
      egress: {
        hosts: [{ hostname: "127.0.0.1", ports: [11434] }],
        privateCidrs: [],
        allowLocalLoopback: true,
      },
    }),
  );
  assert.equal(value.enabled, true);
  assert.equal(
    value.policy.endpoint("http://127.0.0.1:11434", "local").origin,
    "http://127.0.0.1:11434",
  );
  assert.equal(value.policy.address("127.0.0.1", "local"), true);
  assert.equal(value.policy.address("127.0.0.1", "remote"), false);
  assert.throws(() =>
    value.policy.endpoint("https://api.openai.com", "remote"),
  );
  assert.throws(() => value.policy.endpoint("http://127.0.0.1:8080", "local"));
});
test("invalid runtime configuration produces a fixed error without echoing input", () => {
  for (const raw of [
    '{"credential":"private-value"}',
    JSON.stringify({ concurrency: 5 }),
    JSON.stringify({ pollEveryMs: 0 }),
    "private-value",
  ]) {
    assert.throws(
      () => StandaloneInvestigationDeployment.fromJSON(raw),
      (error) =>
        error instanceof Error &&
        error.message === "Invalid ESCALATOR_INVESTIGATION configuration",
    );
  }
});
