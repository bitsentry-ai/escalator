import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import {
  HealthDeployment,
  OperationalHealthHttp,
  defaultHealthPolicy,
  type OperationalHealth,
} from "../src/application/index.js";
const token = Buffer.alloc(32, 17).toString("base64url");
const hash = createHash("sha256").update(token).digest("hex");
const deployment = () => new HealthDeployment({ readinessTokenSha256: hash });
const ready: OperationalHealth = {
  ready: true,
  reasons: [],
  databaseNow: "2026-10-03T00:00:00.000Z",
  schedulerMaxAgeMs: 0,
  lagMs: { jobs: null, outbox: null, paging: null },
};
test("readiness credentials are exact bearer capabilities and remain disabled without configuration", () => {
  const enabled = deployment();
  assert.equal(enabled.authorized(`Bearer ${token}`), true);
  assert.equal(enabled.authorized(`bearer ${token}`), true);
  for (const value of [
    undefined,
    "",
    token,
    `Basic ${token}`,
    `Bearer ${token} `,
    `Bearer ${token}=`,
    `Bearer ${"a".repeat(43)}`,
  ])
    assert.equal(enabled.authorized(value), false);
  assert.equal(new HealthDeployment().authorized(`Bearer ${token}`), false);
});
test("trusted limits and watchdog settings are bounded, immutable and redacted on failure", () => {
  const input = {
    limits: { maxPagingLagMs: 30000 },
    watchdog: { secretId: "watchdog-secret", intervalSeconds: 60 },
  };
  const parsed = new HealthDeployment(input);
  input.limits.maxPagingLagMs = 1;
  input.watchdog.secretId = "different";
  assert.equal(parsed.policy.maxPagingLagMs, 30000);
  assert.equal(parsed.policy.maxJobLagMs, defaultHealthPolicy.maxJobLagMs);
  assert.equal(parsed.watchdog?.secretId, "watchdog-secret");
  assert.equal(Object.isFrozen(parsed.policy), true);
  assert.equal(Object.isFrozen(parsed.watchdog), true);
  for (const value of [
    { readinessToken: token },
    { readinessTokenSha256: "private-value" },
    { limits: { queryTimeoutMs: 99999 } },
    { watchdog: { secretId: "secret", intervalSeconds: 1 } },
  ])
    assert.throws(
      () => new HealthDeployment(value),
      /^Error: Invalid operational health configuration$/,
    );
  assert.throws(
    () => HealthDeployment.fromJSON('{"private-token":'),
    /^Error: Invalid operational health configuration$/,
  );
  assert.throws(
    () => HealthDeployment.fromJSON(" ".repeat(8193)),
    /^Error: Invalid operational health configuration$/,
  );
});
test("unauthorized and foreign-scope requests never query operational state", async () => {
  let checks = 0;
  const http = new OperationalHealthHttp((scope) =>
    scope === "org_a"
      ? {
          deployment: deployment(),
          health: {
            check: async () => {
              checks++;
              return ready;
            },
          },
        }
      : undefined,
  );
  for (const [scope, auth] of [
    ["org_a", undefined],
    ["org_b", `Bearer ${token}`],
    ["org_a", `Bearer ${"b".repeat(43)}`],
    ["a".repeat(161), `Bearer ${token}`],
  ]) {
    const result = await http.readiness(scope!, auth);
    assert.deepEqual(result, { status: 401, body: { error: "unauthorized" } });
  }
  assert.equal(checks, 0);
});
test("authorized readiness reflects actual health and unavailable runtimes", async () => {
  const healthy = new OperationalHealthHttp(() => ({
    deployment: deployment(),
    health: { check: async () => ready },
  }));
  assert.deepEqual(await healthy.readiness("local", `Bearer ${token}`), {
    status: 200,
    body: ready,
  });
  const late: OperationalHealth = {
    ...ready,
    ready: false,
    reasons: ["paging_overdue"],
    lagMs: { jobs: 90000, outbox: null, paging: 90000 },
  };
  const unhealthy = new OperationalHealthHttp(() => ({
    deployment: deployment(),
    health: { check: async () => late },
  }));
  assert.deepEqual(await unhealthy.readiness("local", `Bearer ${token}`), {
    status: 503,
    body: late,
  });
  const absent = new OperationalHealthHttp(() => ({
    deployment: deployment(),
  }));
  assert.deepEqual(await absent.readiness("local", `Bearer ${token}`), {
    status: 503,
    body: { error: "unavailable" },
  });
  const throws = new OperationalHealthHttp(() => ({
    deployment: deployment(),
    health: {
      check: async () => {
        throw new Error("private SQL");
      },
    },
  }));
  assert.deepEqual(await throws.readiness("local", `Bearer ${token}`), {
    status: 503,
    body: { error: "unavailable" },
  });
});
