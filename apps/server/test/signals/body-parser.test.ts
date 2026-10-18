import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { json, type Request, type Response } from "express";
import { SIGNAL_INGRESS_MAX_BYTES } from "@bitsentry-escalator/features/contracts";
import { signalBodyParser } from "../../src/platform/http/ingest/body-parser.js";

async function read(
  chunks: Buffer[],
  headers: Record<string, string | undefined> = {},
  limit = SIGNAL_INGRESS_MAX_BYTES,
) {
  const stream = new PassThrough();
  const socket = Object.assign(new EventEmitter(), {
    readable: true,
    writable: true,
  });
  const request = Object.assign(stream, {
    headers: {
      "content-type": "application/json",
      "transfer-encoding": "chunked",
      ...headers,
    },
    method: "POST",
    complete: false,
    socket,
  });
  request.once("end", () => {
    request.complete = true;
  });
  let status = 200;
  let errorBody: unknown;
  const response = Object.assign(new EventEmitter(), {
    headersSent: false,
    setHeader() {},
    status(value: number) {
      status = value;
      return this;
    },
    json(body: unknown) {
      errorBody = body;
      finish();
      return this;
    },
  });
  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  signalBodyParser(limit)(
    request as unknown as Request,
    response as unknown as Response,
    (error) => {
      assert.equal(error, undefined);
      finish();
    },
  );
  for (const chunk of chunks) stream.write(chunk);
  stream.end();
  await done;
  return {
    request: request as unknown as Request,
    response: response as unknown as Response,
    status,
    errorBody,
  };
}
test("ingress buffers raw bytes before the broad JSON parser can inspect them", async () => {
  const body = Buffer.from('{"evidence":"unchanged bytes"}');
  const result = await read([body.subarray(0, 8), body.subarray(8)]);
  assert.equal(result.status, 200);
  assert.deepEqual(result.request.body, body);
  let parsed = false;
  await new Promise<void>((resolve, reject) => {
    json({
      limit: "25mb",
      verify: () => {
        parsed = true;
      },
    })(result.request, result.response, (error) =>
      error ? reject(error) : resolve(),
    );
  });
  assert.equal(parsed, false);
  assert.deepEqual(result.request.body, body);
});
test("chunked bodies beyond the limit are rejected without JSON parsing", async () => {
  const result = await read([
    Buffer.alloc(SIGNAL_INGRESS_MAX_BYTES),
    Buffer.from("{"),
  ]);
  assert.equal(result.status, 413);
  assert.deepEqual(result.errorBody, { error: "body_too_large" });
  assert.equal(Buffer.isBuffer(result.request.body), false);
});
test("compressed ingestion is rejected rather than expanded", async () => {
  const result = await read([Buffer.from("not gzip")], {
    "content-encoding": "gzip",
  });
  assert.equal(result.status, 415);
  assert.deepEqual(result.errorBody, { error: "unsupported_content_type" });
});

test("a bodyless request remains bounded input for JSON validation", async () => {
  const result = await read([], { "transfer-encoding": undefined });
  assert.deepEqual(result.request.body, Buffer.alloc(0));
});

test("heartbeat streaming limit is smaller than the generic ingress limit", async () => {
  const result = await read([Buffer.alloc(2048), Buffer.from("x")], {}, 2048);
  assert.equal(result.status, 413);
  assert.deepEqual(result.errorBody, { error: "body_too_large" });
});
