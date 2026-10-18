import test from "node:test";
import assert from "node:assert/strict";
import { listenPort } from "../../src/platform/http/listen-port.js";
import { isShellRequest } from "../../src/platform/http/static-web.js";
test("production port parsing refuses invalid syntax, zero and overflow", () => {
  assert.equal(listenPort(undefined), 3000);
  assert.equal(listenPort("8080"), 8080);
  for (const raw of ["", "0", "-1", "1e3", "3000x", "65536", " 3000"])
    assert.throws(() => listenPort(raw));
});
test("shell cannot shadow acknowledgement, health, ingress or API routes", () => {
  assert.equal(
    isShellRequest("GET", "/", "text/html,application/xhtml+xml"),
    true,
  );
  assert.equal(isShellRequest("HEAD", "/", "text/html"), true);
  for (const path of [
    "/ack/local",
    "/ack/local/state",
    "/health/ready",
    "/HEALTH/ready",
    "/v1/ingest",
    "/trpc/rules.list",
    "/unknown",
    "/assets/missing.js",
  ])
    assert.equal(isShellRequest("GET", path, "text/html"), false, path);
  for (const method of ["POST", "PUT", "DELETE"])
    assert.equal(isShellRequest(method, "/", "text/html"), false);
  assert.equal(isShellRequest("GET", "/", "application/json"), false);
  assert.equal(isShellRequest("GET", "/", undefined), false);
});
