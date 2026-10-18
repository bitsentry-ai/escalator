import test from "node:test";
import assert from "node:assert/strict";
import { ZodError } from "zod";
import {
  DeploymentHttp,
  DEPLOYMENT_MAX_BYTES,
  type DeploymentHttpRequest,
} from "../src/application/deploy/http.js";
import { DeploymentAccessError } from "../src/application/deploy/access.js";
import {
  DeploymentCommandError,
  type DeploymentCommands,
} from "../src/application/deploy/commands.js";
import type { DeploymentReceipt } from "../src/contracts/index.js";
const token = `edp_${"a".repeat(43)}`;
const accepted: DeploymentReceipt["result"] = {
  state: "accepted",
  deploymentId: "deployment",
  revision: 1,
  status: "STARTED",
};
const request = (
  patch: Partial<DeploymentHttpRequest> = {},
): DeploymentHttpRequest => ({
  authorization: `Bearer ${token}`,
  contentType: "application/json",
  idempotencyKey: "request-1",
  body: new TextEncoder().encode(JSON.stringify({ version: 1 })),
  ...patch,
});
const handlers = (
  run: () => Promise<DeploymentReceipt["result"]>,
): Pick<DeploymentCommands, "start" | "finish"> => ({
  start: run,
  finish: run,
});

test("deployment HTTP preserves committed/replayed results and forwards only parsed inputs", async () => {
  const calls: unknown[][] = [];
  const http = new DeploymentHttp({
    start: async (...args) => {
      calls.push(args);
      return accepted;
    },
    finish: async (...args) => {
      calls.push(args);
      return { ...accepted, state: "duplicate" };
    },
  });
  assert.deepEqual(await http.start(request()), {
    status: 202,
    body: accepted,
  });
  assert.deepEqual(calls[0], [token, "request-1", { version: 1 }]);
  assert.equal((await http.finish("deployment", request())).status, 200);
  assert.deepEqual(calls[1], [
    token,
    "deployment",
    "request-1",
    { version: 1 },
  ]);
  const rejected = new DeploymentHttp(
    handlers(async () => ({
      state: "rejected",
      deploymentId: null,
      reason: "missing_start",
    })),
  );
  assert.equal((await rejected.finish("missing", request())).status, 409);
});

test("invalid framing, credentials and idempotency headers never invoke command handlers", async () => {
  const http = new DeploymentHttp(
    handlers(async () => {
      throw new Error("unexpected command");
    }),
  );
  for (const [patch, status] of [
    [{ body: new Uint8Array(DEPLOYMENT_MAX_BYTES + 1) }, 413],
    [{ contentType: "text/plain" }, 415],
    [{ authorization: undefined }, 401],
    [{ authorization: `Bearer ${token}, ${token}` }, 401],
    [{ authorization: `Bearer EDP_${"a".repeat(43)}` }, 401],
    [{ idempotencyKey: undefined }, 400],
    [{ idempotencyKey: "duplicate,header" }, 400],
    [{ body: new Uint8Array([0xff]) }, 400],
    [{ body: new TextEncoder().encode("{") }, 400],
  ] as const)
    assert.equal((await http.start(request(patch))).status, status);
  assert.equal((await http.finish("bad/id", request())).status, 400);
});

test("transport errors are bounded codes and never echo private exception text", async () => {
  for (const [error, status, code] of [
    [new DeploymentAccessError(), 401, "invalid_token"],
    [new ZodError([]), 400, "invalid_input"],
    [
      new DeploymentCommandError("idempotency_conflict"),
      409,
      "idempotency_conflict",
    ],
    [new DeploymentCommandError("conflict"), 409, "conflict"],
    [new Error(`private token ${token}`), 503, "unavailable"],
  ] as const) {
    const http = new DeploymentHttp(
      handlers(async () => {
        throw error;
      }),
    );
    assert.deepEqual(await http.start(request()), {
      status,
      body: { error: code },
    });
  }
});

test("deployment ingress rejects excess work without queuing and releases slots only after settlement", async () => {
  let release!: (value: DeploymentReceipt["result"]) => void,
    calls = 0;
  const pending = new Promise<DeploymentReceipt["result"]>((resolve) => {
    release = resolve;
  });
  const http = new DeploymentHttp(
    handlers(async () => {
      calls++;
      return calls === 1 ? pending : accepted;
    }),
    () => true,
    1,
  );
  const first = http.start(request());
  assert.deepEqual(await http.start(request()), {
    status: 429,
    body: { error: "busy" },
  });
  assert.equal(calls, 1);
  release(accepted);
  assert.equal((await first).status, 202);
  assert.equal((await http.start(request())).status, 202);
  assert.equal(calls, 2);
  const unavailable = new DeploymentHttp(
    handlers(async () => {
      throw new Error("unexpected command");
    }),
    () => false,
  );
  assert.deepEqual(await unavailable.start(request()), {
    status: 503,
    body: { error: "unavailable" },
  });
  const brokenAvailability = new DeploymentHttp(
    handlers(async () => accepted),
    () => {
      throw new Error("private config");
    },
  );
  assert.deepEqual(await brokenAvailability.start(request()), {
    status: 503,
    body: { error: "unavailable" },
  });
  let failed = false;
  const recovery = new DeploymentHttp(
    handlers(async () => {
      if (!failed) {
        failed = true;
        throw new Error("store offline");
      }
      return accepted;
    }),
    () => true,
    1,
  );
  assert.equal((await recovery.start(request())).status, 503);
  assert.equal((await recovery.start(request())).status, 202);
  assert.throws(
    () =>
      new DeploymentHttp(
        handlers(async () => accepted),
        () => true,
        0,
      ),
    RangeError,
  );
});
