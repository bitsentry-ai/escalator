import test from "node:test";
import assert from "node:assert/strict";
import { httpProbeConfigSchema } from "../src/contracts/probes.js";
import { workspaceIdSchema } from "../src/contracts/identity.js";
import { HttpProbeRunner } from "../src/application/probes/http-runner.js";
import {
  ProbeTransportError,
  type ProbeRequest,
} from "../src/application/probes/transport.js";
import type { SecretStore } from "../src/application/ports/secrets.js";
const config = httpProbeConfigSchema.parse({
  url: "https://example.test/health",
  method: "GET",
  body: null,
  authSecretId: null,
  timeoutMs: 1000,
  maxResponseBytes: 1000,
  assertions: { status: [200], contains: "healthy", json: [] },
  syntheticWrite: null,
});
const execution = () => ({
  workspaceId: workspaceIdSchema.parse("local"),
  workId: "probe-run",
  claimToken: "claim",
  signal: new AbortController().signal,
});
test("HTTP runner returns only bounded verdict metadata, never response evidence or credentials", async () => {
  const calls: ProbeRequest[] = [];
  const bytes = Buffer.from(
    JSON.stringify({ header: "authorization", value: "Bearer private-token" }),
  );
  let scope: unknown;
  const secrets: SecretStore = {
    withSecret: async (use, consume) => {
      scope = use.workspaceId;
      try {
        return await consume(bytes);
      } finally {
        bytes.fill(0);
      }
    },
  };
  const runner = new HttpProbeRunner(
    {
      exchange: async (request) => {
        calls.push({ ...request, headers: { ...request.headers } });
        return { status: 200, body: "healthy secret-response" };
      },
    },
    secrets,
    () => 10,
  );
  const result = await runner.run(
    { ...config, authSecretId: "credential" },
    execution(),
  );
  assert.deepEqual(result, {
    outcome: "healthy",
    reason: "assertions_passed",
    statusCode: 200,
    durationMs: 0,
  });
  assert.equal(scope, "local");
  assert.equal(calls[0].headers.authorization, "Bearer private-token");
  assert.ok(bytes.every((value) => value === 0));
  assert.equal(JSON.stringify(result).includes("secret"), false);
});
test("network failures remain failures when the host secret adapter masks callback exceptions", async () => {
  const secrets: SecretStore = {
    withSecret: async (_use, consume) => {
      try {
        return await consume(
          Buffer.from('{"header":"x-api-key","value":"private"}'),
        );
      } catch {
        throw new Error("secret access failed");
      }
    },
  };
  const runner = new HttpProbeRunner(
    {
      exchange: async () => {
        throw new ProbeTransportError("timeout");
      },
    },
    secrets,
  );
  const result = await runner.run(
    { ...config, authSecretId: "credential" },
    execution(),
  );
  assert.equal(result.outcome, "failed");
  assert.equal(result.reason, "timeout");
});
test("credential errors, denied destinations and cancellations never manufacture recovery", async () => {
  const transport = {
    exchange: async () => {
      throw new Error("must not call");
    },
  };
  const runner = new HttpProbeRunner(transport);
  assert.equal(
    (await runner.run({ ...config, authSecretId: "missing" }, execution()))
      .reason,
    "secret_unavailable",
  );
  assert.equal(
    (
      await runner.run(
        { ...config, url: "http://example.test", authSecretId: "credential" },
        execution(),
      )
    ).reason,
    "destination_denied",
  );
  const use = execution();
  use.signal = AbortSignal.abort();
  assert.equal((await runner.run(config, use)).reason, "cancelled");
  const denied = await new HttpProbeRunner({
    exchange: async () => {
      throw new ProbeTransportError("destination_denied");
    },
  }).run(config, execution());
  assert.equal(denied.outcome, "unknown");
});
test("synthetic requests reuse one idempotency key for the same durable run and reject missing markers", async () => {
  const requests: ProbeRequest[] = [];
  const runner = new HttpProbeRunner({
    exchange: async (input) => {
      requests.push(input);
      return { status: 200, body: "healthy" };
    },
  });
  const write = httpProbeConfigSchema.parse({
    ...config,
    method: "POST",
    body: '{"test":true}',
    syntheticWrite: {
      markerPath: ["test"],
      markerValue: true,
      idempotencyHeader: "Idempotency-Key",
      cleanupGuidance: "Delete the test record",
    },
  });
  await runner.run(write, execution());
  await runner.run(write, execution());
  await runner.run(write, { ...execution(), workId: "next-run" });
  assert.equal(
    requests[0].headers["Idempotency-Key"],
    requests[1].headers["Idempotency-Key"],
  );
  assert.notEqual(
    requests[0].headers["Idempotency-Key"],
    requests[2].headers["Idempotency-Key"],
  );
  assert.equal(
    (await runner.run({ ...write, body: "{}" }, execution())).reason,
    "invalid_configuration",
  );
  assert.equal(requests.length, 3);
});
