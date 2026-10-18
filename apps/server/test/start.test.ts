import test from "node:test";
import assert from "node:assert/strict";
import { reportStartupFailure } from "../src/platform/http/startup-error.js";
test("startup failure reports its cause and an unsuccessful exit without starting a server", () => {
  const previous = console.error;
  const exitCode = process.exitCode;
  let output = "";
  console.error = (...args: unknown[]) => {
    output += args.join(" ");
  };
  try {
    reportStartupFailure(new Error("database authentication failed (28P01)"));
    assert.match(output, /database authentication failed \(28P01\)/);
    assert.equal(process.exitCode, 1);
  } finally {
    console.error = previous;
    process.exitCode = exitCode;
  }
});
