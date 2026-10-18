import test from "node:test";
import assert from "node:assert/strict";
import { workspaceIdSchema } from "../src/contracts/identity.js";
import {
  HeartbeatHttp,
  HEARTBEAT_MAX_BYTES,
} from "../src/application/probes/heartbeat-http.js";
import { MemoryHeartbeatRepository } from "./conformance/memory-heartbeats.js";
import {
  seedHeartbeatFixture,
  heartbeatTestToken,
} from "./conformance/heartbeats.js";
const now = "2026-10-03T00:00:00.000Z";
const body = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));
async function fixture() {
  const repository = new MemoryHeartbeatRepository(() => new Date(now));
  const scope = workspaceIdSchema.parse("http-heartbeats");
  await repository.transaction(scope, seedHeartbeatFixture);
  const http = new HeartbeatHttp(repository, (id) => id === scope);
  const request = {
    probeId: "heartbeat",
    authorization: `Bearer ${heartbeatTestToken}`,
    contentType: "application/json",
    body: body({ version: 1, eventId: "ping", observedAt: now }),
  };
  return { repository, scope, http, request };
}
test("heartbeat HTTP returns the original receipt for retries without extending the deadline", async () => {
  const f = await fixture();
  const first = await f.http.accept(f.request);
  assert.equal(first.status, 202);
  const retry = await f.http.accept(f.request);
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.body, { ...first.body, state: "duplicate" });
  assert.equal(
    (
      await f.http.accept({
        ...f.request,
        body: body({ version: 1, eventId: "another", observedAt: now }),
      })
    ).status,
    409,
  );
});
test("heartbeat HTTP rejects oversized, malformed and caller-scoped payloads before intake", async () => {
  const f = await fixture();
  for (const [input, status] of [
    [{ body: new Uint8Array(HEARTBEAT_MAX_BYTES + 1) }, 413],
    [{ contentType: "text/plain" }, 415],
    [{ authorization: "Bearer wrong" }, 401],
    [{ body: new Uint8Array([0xff]) }, 400],
    [
      {
        body: body({
          version: 1,
          eventId: "ping",
          observedAt: now,
          workspaceId: "other",
        }),
      },
      400,
    ],
    [{ probeId: "other" }, 401],
  ] as const)
    assert.equal(
      (await f.http.accept({ ...f.request, ...input })).status,
      status,
    );
  await f.repository.transaction(f.scope, async (tx) =>
    assert.equal((await tx.heartbeats.state("heartbeat"))?.generation, 1),
  );
});
test("heartbeat HTTP honors rollout and availability and never exposes storage errors", async () => {
  const f = await fixture();
  assert.equal(
    (await new HeartbeatHttp(f.repository, () => false).accept(f.request))
      .status,
    401,
  );
  const unavailable = new HeartbeatHttp(
    {
      transaction: f.repository.transaction.bind(f.repository),
      findGrantContext: async () => {
        throw new Error("private database detail");
      },
    },
    () => true,
  );
  assert.deepEqual(await unavailable.accept(f.request), {
    status: 503,
    body: { error: "unavailable" },
  });
  assert.deepEqual(
    await new HeartbeatHttp(
      f.repository,
      () => true,
      () => false,
    ).accept(f.request),
    { status: 503, body: { error: "unavailable" } },
  );
});
