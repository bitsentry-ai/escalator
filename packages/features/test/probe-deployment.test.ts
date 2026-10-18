import { test } from "node:test";
import assert from "node:assert/strict";
import { ProbeDeployment } from "../src/application/probes/deployment.js";
test("deployment defaults deny destinations and freeze conservative limits", () => {
  const config = ProbeDeployment.fromJSON(undefined);
  assert.throws(() => config.policy.target("https://example.com"));
  assert.equal(config.limits.concurrency, 4);
  assert.ok(Object.isFrozen(config.limits));
});
test("deployment rules are bounded, strict and errors redact supplied configuration", () => {
  const input = {
    destinations: {
      hosts: [{ hostname: "internal.example", ports: [443] }],
      privateCidrs: ["10.0.0.0/8"],
    },
    limits: { maxActive: 4, maxConfigured: 10, concurrency: 2 },
  };
  const config = ProbeDeployment.fromJSON(JSON.stringify(input));
  assert.equal(
    config.policy.target("https://internal.example/check").hostname,
    "internal.example",
  );
  assert.equal(config.policy.address("10.1.2.3"), true);
  assert.throws(() => config.policy.target("https://other.example"));
  for (const value of [
    "{",
    " ".repeat(131073),
    JSON.stringify({ ...input, unexpected: true }),
    JSON.stringify({ ...input, limits: { ...input.limits, concurrency: 33 } }),
    JSON.stringify({
      destinations: { ...input.destinations, privateCidrs: ["bad-secret"] },
    }),
  ]) {
    assert.throws(() => ProbeDeployment.fromJSON(value), {
      message: "Invalid probe deployment configuration",
    });
  }
});
