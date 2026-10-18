import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import type {
  ProviderHttp,
  ProviderHttpRequest,
} from "@bitsentry-escalator/features/application";
import { ProviderIngestController } from "../../src/platform/http/ingest/provider.controller.js";
function transport(body: unknown) {
  const req = Object.assign(new EventEmitter(), {
    body,
    headers: {
      "content-type": "application/json",
      "sentry-hook-signature": "signature",
      cookie: "untrusted",
    },
  });
  const res = Object.assign(new EventEmitter(), {
    writableEnded: false,
    destroyed: false,
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    setHeader(key: string, value: string) {
      this.headers[key] = value;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(value: unknown) {
      this.body = value;
      this.writableEnded = true;
      return this;
    },
  });
  return { req, res };
}
test("provider controller preserves signed bytes, excludes sessions and clears raw evidence", async () => {
  const data = Buffer.from('{ "signed": true }');
  const f = transport(data);
  let captured: ProviderHttpRequest | undefined;
  const controller = new ProviderIngestController({
    accept: async (request: ProviderHttpRequest) => {
      captured = request;
      assert.equal(Buffer.from(request.body).toString(), '{ "signed": true }');
      return { status: 202, body: { state: "accepted", signalIds: ["event"] } };
    },
  } as unknown as ProviderHttp);
  await controller.accept(
    "sentry",
    "receiver",
    f.req as unknown as Request,
    f.res as unknown as Response,
  );
  assert.equal(captured?.signature, "signature");
  assert.equal("cookie" in captured!, false);
  assert.equal(f.req.body, undefined);
  assert.ok(data.every((value) => value === 0));
  assert.equal(f.res.statusCode, 202);
  assert.equal(f.res.headers["Cache-Control"], "no-store");
  assert.equal(f.req.listenerCount("aborted"), 0);
  assert.equal(f.res.listenerCount("close"), 0);
});
test("provider controller rejects a pre-parsed body and aborts work on disconnected responses", async () => {
  let calls = 0;
  const f = transport(Buffer.from("{}"));
  const controller = new ProviderIngestController({
    accept: async (request: ProviderHttpRequest) => {
      calls++;
      f.res.emit("close");
      assert.equal(request.signal.aborted, true);
      return { status: 503, body: { error: "unavailable" } };
    },
  } as unknown as ProviderHttp);
  const invalid = transport({ parsed: true });
  await controller.accept(
    "sentry",
    "receiver",
    invalid.req as unknown as Request,
    invalid.res as unknown as Response,
  );
  assert.equal(calls, 0);
  assert.equal(invalid.res.statusCode, 503);
  await controller.accept(
    "sentry",
    "receiver",
    f.req as unknown as Request,
    f.res as unknown as Response,
  );
  assert.equal(calls, 1);
});
