import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import type {
  SignalHttp,
  SignalHttpRequest,
} from "@bitsentry-escalator/features/application";
import { SignalIngestController } from "../../src/platform/http/ingest/ingest.controller.js";
function response() {
  const value = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    setHeader(key: string, header: string) {
      this.headers[key] = header;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return value;
}
test("controller rejects an unbounded decoded body rather than reparsing it", async () => {
  let called = false;
  const controller = new SignalIngestController({
    accept: async () => {
      called = true;
    },
  } as unknown as SignalHttp);
  const req = {
    body: { unexpected: "preparsed" },
    headers: {},
  } as unknown as Request;
  const res = response();
  await controller.accept("source", req, res as unknown as Response);
  assert.equal(called, false);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: "unavailable" });
  assert.equal(req.body, undefined);
});
test("controller forwards only machine credentials and removes raw evidence from the request", async () => {
  let captured: SignalHttpRequest | undefined;
  const controller = new SignalIngestController({
    accept: async (request: SignalHttpRequest) => {
      captured = request;
      return { status: 202, body: { state: "accepted", signalId: "event" } };
    },
  } as unknown as SignalHttp);
  const bytes = Buffer.from("{}");
  const req = {
    body: bytes,
    headers: {
      authorization: "Bearer token",
      "content-type": "application/json",
      cookie: "session=untrusted",
    },
  } as unknown as Request;
  const res = response();
  await controller.accept("source", req, res as unknown as Response);
  assert.deepEqual(captured, {
    sourceId: "source",
    body: bytes,
    authorization: "Bearer token",
    contentType: "application/json",
  });
  assert.equal(req.body, undefined);
  assert.equal(res.statusCode, 202);
  assert.equal(res.headers["Cache-Control"], "no-store");
});
