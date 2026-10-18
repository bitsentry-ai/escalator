import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import type { DeploymentWatchHttp } from "@bitsentry-escalator/features/application";
import { DeploymentWatchController } from "../../src/features/deploy/watch.controller.js";

test("watch GET forwards only bearer authority and never caches its response", async () => {
  const calls: unknown[] = [],
    headers = new Map<string, string>();
  const http = {
    read: async (...args: unknown[]) => {
      calls.push(args);
      return { status: 503, body: { error: "unavailable" } };
    },
  } as unknown as DeploymentWatchHttp;
  const controller = new DeploymentWatchController(http);
  let status = 0;
  const res = {
    setHeader: (key: string, value: string) => headers.set(key, value),
    status: (value: number) => {
      status = value;
      return res;
    },
    json: () => res,
  } as unknown as Response;
  await controller.read(
    "deployment",
    {
      headers: { authorization: "Bearer grant" },
      query: { token: "ignored" },
      cookies: { token: "ignored" },
    } as unknown as Request,
    res,
  );
  assert.deepEqual(calls, [["deployment", "Bearer grant"]]);
  assert.equal(status, 503);
  assert.equal(headers.get("Cache-Control"), "no-store");
  assert.equal(headers.get("Retry-After"), "1");
});
