import test from "node:test";
import assert from "node:assert/strict";
import type { Response } from "express";
import type { AcknowledgementHttp } from "@bitsentry-escalator/features/application";
import { EscalatorAcknowledgementController } from "../../src/platform/http/ack/ack.controller.js";
test("standalone acknowledgement controller serves a static shell and separates GET from POST", async () => {
  const calls: unknown[][] = [];
  const http = {
    execute: async (...args: unknown[]) => {
      calls.push(args);
      return { state: "invalid" };
    },
  } as unknown as AcknowledgementHttp;
  const controller = new EscalatorAcknowledgementController(http);
  const sent: unknown[] = [];
  const response = {
    set() {
      return this;
    },
    type() {
      return this;
    },
    send(value: unknown) {
      sent.push(value);
      return this;
    },
  } as unknown as Response;
  controller.view(response);
  controller.asset(response);
  assert.equal(calls.length, 0);
  assert.match(String(sent[0]), /assets\/client.js/);
  assert.ok(String(sent[1]).length > 100);
  await controller.preview("local", "Bearer fixture", response);
  await controller.acknowledge("local", "Bearer fixture", response);
  assert.deepEqual(calls, [
    ["GET", "local", "Bearer fixture"],
    ["POST", "local", "Bearer fixture"],
  ]);
  assert.equal(
    Object.keys(require.cache).some((file) =>
      /node_modules\/(react|react-dom)\//.test(file),
    ),
    false,
  );
});
