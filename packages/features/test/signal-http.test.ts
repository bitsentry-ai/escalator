import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { SignalHttp } from "../src/application/signals/http.js";
import { signalTokenDigest } from "../src/application/signals/ingest.js";
import { MemorySignalRepository } from "./conformance/memory-signals.js";
import { seedSignalFixture, fixtureToken } from "./conformance/signals.js";
import {
  workspaceIdSchema,
  SIGNAL_INGRESS_MAX_BYTES,
} from "../src/contracts/index.js";
const payload = {
  version: 1,
  eventId: "event",
  fingerprint: "errors",
  observedAt: "2026-09-20T00:00:00.000Z",
  status: "active",
  severity: "critical",
  title: "Error",
  evidence: { summary: "Failed", attributes: [] },
};
async function fixture(allowed = true) {
  const repository = new MemorySignalRepository();
  const scope = workspaceIdSchema.parse("workspace");
  const token = `esi_${randomBytes(32).toString("base64url")}`;
  await repository.transaction(scope, async (tx) => {
    await seedSignalFixture(tx);
    await tx.tokens.insert(fixtureToken(tx, signalTokenDigest(token)!));
  });
  const http = new SignalHttp(repository, (id) => allowed && id === scope);
  const request = {
    sourceId: "source",
    contentType: "application/json",
    authorization: `Bearer ${token}`,
    body: Buffer.from(JSON.stringify(payload)),
  };
  return { http, request, repository };
}
test("HTTP ingress returns accepted then duplicate without exposing grant details", async () => {
  const { http, request } = await fixture();
  const first = await http.accept(request);
  assert.equal(first.status, 202);
  assert.equal((await http.accept(request)).status, 200);
  assert.equal(JSON.stringify(first).includes(request.authorization), false);
  assert.equal(
    (
      await http.accept({
        ...request,
        contentType: "application/json; charset=utf-8",
      })
    ).status,
    200,
  );
});
test("host workspace admission rejects otherwise-valid tokens uniformly", async () => {
  const { http, request } = await fixture(false);
  assert.deepEqual(await http.accept(request), {
    status: 401,
    body: { error: "invalid_token" },
  });
  assert.deepEqual(await http.accept({ ...request, sourceId: "foreign" }), {
    status: 401,
    body: { error: "invalid_token" },
  });
});
test("missing or malformed bearer credentials never authenticate via cookies", async () => {
  const { http, request } = await fixture();
  for (const authorization of [
    undefined,
    "",
    "Basic secret",
    `${request.authorization}, other`,
    ` ${request.authorization}`,
  ])
    assert.equal(
      (await http.accept({ ...request, authorization })).status,
      401,
    );
});
test("malformed, oversized, wrong-media and scope-bearing inputs fail without acceptance", async () => {
  const { http, request } = await fixture();
  assert.equal(
    (await http.accept({ ...request, contentType: "text/plain" })).status,
    415,
  );
  assert.equal(
    (
      await http.accept({
        ...request,
        contentType: "application/json; charset=latin1",
      })
    ).status,
    415,
  );
  assert.equal(
    (await http.accept({ ...request, body: Buffer.from("{") })).status,
    400,
  );
  assert.equal(
    (await http.accept({ ...request, body: Buffer.from([0xff]) })).status,
    400,
  );
  assert.equal(
    (
      await http.accept({
        ...request,
        body: Buffer.alloc(SIGNAL_INGRESS_MAX_BYTES + 1),
      })
    ).status,
    413,
  );
  assert.equal(
    (
      await http.accept({
        ...request,
        body: Buffer.from(
          JSON.stringify({ ...payload, workspaceId: "foreign" }),
        ),
      })
    ).status,
    400,
  );
  assert.equal((await http.accept(request)).status, 202);
});
test("unavailable persistence produces only a retryable generic failure", async () => {
  const f = await fixture();
  const http = new SignalHttp(
    {
      transaction: (scope, run) => f.repository.transaction(scope, run),
      findTokenContext: async () => {
        throw new Error(`sensitive ${f.request.authorization}`);
      },
    },
    () => true,
  );
  assert.deepEqual(await http.accept(f.request), {
    status: 503,
    body: { error: "unavailable" },
  });
});
