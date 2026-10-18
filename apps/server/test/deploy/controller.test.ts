import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import type { DeploymentHttp } from "@bitsentry-escalator/features/application";
import { DeploymentController } from "../../src/features/deploy/deploy.controller.js";
test("deployment ingress requires raw bytes, strips request evidence and forwards only machine headers", async () => {
  const calls: unknown[] = [];
  const http = {
    start: async (input: unknown) => {
      calls.push(input);
      return { status: 429, body: { error: "busy" } };
    },
    finish: async (id: string, input: unknown) => {
      calls.push([id, input]);
      return { status: 202, body: { state: "accepted" } };
    },
  } as unknown as DeploymentHttp;
  const controller = new DeploymentController(http);
  const headers = new Map<string, string>();
  let status = 0;
  const response = {
    setHeader: (key: string, value: string) => headers.set(key, value),
    status: (code: number) => {
      status = code;
      return response;
    },
    json: () => response,
  } as unknown as Response;
  const malformed = { body: { secret: "private" }, headers: {} } as Request;
  await controller.start(malformed, response);
  assert.equal(status, 503);
  assert.equal(calls.length, 0);
  assert.equal(malformed.body, undefined);
  const req = {
    body: Buffer.from("{}"),
    headers: {
      authorization: "Bearer token",
      "content-type": "application/json",
      "idempotency-key": ["a", "b"],
    },
  } as unknown as Request;
  await controller.start(req, response);
  assert.equal(req.body, undefined);
  assert.equal(status, 429);
  assert.deepEqual(calls[0], {
    body: Buffer.from("{}"),
    authorization: "Bearer token",
    contentType: "application/json",
    idempotencyKey: undefined,
  });
  assert.equal(headers.get("Retry-After"), "1");
  assert.equal(headers.get("Cache-Control"), "no-store");
  await controller.finish(
    "deployment",
    {
      body: Buffer.from("{}"),
      headers: { "idempotency-key": "one" },
    } as unknown as Request,
    response,
  );
  assert.equal(status, 202);
  assert.deepEqual(calls[1], [
    "deployment",
    {
      body: Buffer.from("{}"),
      authorization: undefined,
      contentType: undefined,
      idempotencyKey: "one",
    },
  ]);
});

test("coverage preflight forwards bounded machine headers and no browser identity", async () => {
  const calls: unknown[] = [];
  const http = {
    preflight: async (request: unknown) => {
      calls.push(request);
      return { status: 200, body: { decision: "block" } };
    },
  } as unknown as DeploymentHttp;
  const controller = new DeploymentController(http),
    headers = new Map<string, string>();
  let status = 0;
  let body: unknown;
  const res = {
    setHeader: (key: string, value: string) => headers.set(key, value),
    status: (code: number) => {
      status = code;
      return res;
    },
    json: (value: unknown) => {
      body = value;
      return res;
    },
  } as unknown as Response;
  const req = {
    body: Buffer.from("{}"),
    headers: {
      authorization: "Bearer token",
      "idempotency-key": "preflight",
      "content-type": "application/json",
    },
    session: { account: { accountId: "untrusted" } },
  } as unknown as Request;
  await controller.preflight(req, res);
  assert.equal(status, 200);
  assert.deepEqual(body, { decision: "block" });
  assert.equal(req.body, undefined);
  assert.equal(headers.get("Cache-Control"), "no-store");
  assert.deepEqual(calls, [
    {
      body: Buffer.from("{}"),
      authorization: "Bearer token",
      idempotencyKey: "preflight",
      contentType: "application/json",
    },
  ]);
});
