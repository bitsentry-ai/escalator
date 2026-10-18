import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Temporal as esm } from "@js-temporal/polyfill";
const cjs = createRequire(import.meta.url)("@js-temporal/polyfill").Temporal;
for (const [format, Temporal] of [
  ["esm", esm],
  ["cjs", cjs],
]) {
  test(`${format} Temporal resolves a repeated local time explicitly`, () => {
    const local = Temporal.PlainDateTime.from("2020-11-01T01:30");
    const first = local.toZonedDateTime("America/Los_Angeles", {
      disambiguation: "earlier",
    });
    const second = local.toZonedDateTime("America/Los_Angeles", {
      disambiguation: "later",
    });
    assert.equal(second.epochMilliseconds - first.epochMilliseconds, 3_600_000);
    assert.throws(
      () =>
        local.toZonedDateTime("America/Los_Angeles", {
          disambiguation: "reject",
        }),
      RangeError,
    );
  });
}
