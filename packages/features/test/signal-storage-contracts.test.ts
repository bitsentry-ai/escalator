import test from "node:test";
import assert from "node:assert/strict";
import { signalInputSchema } from "../src/contracts/index.js";
const input = {
  version: 1,
  eventId: "event",
  fingerprint: "errors",
  observedAt: "2026-10-02T00:00:00.123456Z",
  status: "active",
  severity: "critical",
  title: "Checkout failed",
  evidence: { summary: "HTTP 500", attributes: [] },
};
test("signal timestamps normalize identically to both hosts' millisecond clocks", () => {
  assert.equal(
    signalInputSchema.parse(input).observedAt,
    "2026-10-02T00:00:00.123Z",
  );
  assert.equal(
    signalInputSchema.parse({ ...input, observedAt: "2026-10-02T00:00:00Z" })
      .observedAt,
    "2026-10-02T00:00:00.000Z",
  );
});
test("signal text rejects PostgreSQL-incompatible Unicode without removing valid emoji", () => {
  for (const invalid of ["nul\u0000text", "high\ud800", "low\udc00"]) {
    assert.equal(
      signalInputSchema.safeParse({ ...input, title: invalid }).success,
      false,
    );
    assert.equal(
      signalInputSchema.safeParse({ ...input, eventId: invalid }).success,
      false,
    );
    assert.equal(
      signalInputSchema.safeParse({
        ...input,
        evidence: { summary: invalid, attributes: [] },
      }).success,
      false,
    );
    assert.equal(
      signalInputSchema.safeParse({
        ...input,
        evidence: {
          summary: "bounded",
          attributes: [{ name: "reason", value: invalid }],
        },
      }).success,
      false,
    );
  }
  assert.equal(
    signalInputSchema.parse({ ...input, title: "Checkout 🚨" }).title,
    "Checkout 🚨",
  );
});
