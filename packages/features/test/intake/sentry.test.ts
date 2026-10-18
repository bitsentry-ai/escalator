import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import recorded from "./sentry-issue-alert.json";
import { SIGNAL_INGRESS_MAX_BYTES } from "../../src/contracts/index.js";
import {
  normalizeSentryIssueAlert,
  verifySentrySignature,
  signedSentryIssueAlert,
} from "../../src/adapters/intake/sentry.js";
const secret = Buffer.from("a-test-only-integration-secret");
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const sign = (body: Uint8Array) =>
  createHmac("sha256", secret).update(body).digest("hex");

test("Sentry HMAC covers original bytes; whitespace changes invalidate it", () => {
  const body = Buffer.from(JSON.stringify(recorded, null, 2));
  const signature = sign(body);
  assert.equal(verifySentrySignature(body, signature, secret), true);
  assert.equal(
    verifySentrySignature(body, signature.toUpperCase(), secret),
    true,
  );
  assert.equal(
    verifySentrySignature(bytes(recorded), signature, secret),
    false,
  );
  assert.equal(
    verifySentrySignature(body, signature, Buffer.from("wrong")),
    false,
  );
  for (const value of [
    undefined,
    "",
    "a",
    "0".repeat(63),
    "z".repeat(64),
    `${signature},other`,
  ])
    assert.equal(verifySentrySignature(body, value, secret), false);
  assert.equal(verifySentrySignature(body, signature, Buffer.alloc(0)), false);
  assert.equal(
    verifySentrySignature(
      Buffer.alloc(SIGNAL_INGRESS_MAX_BYTES + 1),
      signature,
      secret,
    ),
    false,
  );
});
test("recorded Sentry issue alert yields stable identities and canonical observation time", () => {
  const signal = normalizeSentryIssueAlert(bytes(recorded));
  assert.equal(signal.eventId, `sentry:${recorded.data.event.event_id}`);
  assert.equal(signal.observedAt, "2019-08-19T21:06:17.677Z");
  assert.equal(signal.status, "active");
  assert.equal(signal.severity, "high");
  const another = structuredClone(recorded);
  another.data.event.event_id = "f".repeat(32);
  assert.equal(
    normalizeSentryIssueAlert(bytes(another)).fingerprint,
    signal.fingerprint,
  );
  another.data.event.project += 1;
  assert.notEqual(
    normalizeSentryIssueAlert(bytes(another)).fingerprint,
    signal.fingerprint,
  );
});
test("provider headers, users, titles and exception data cannot become scope or retained evidence", () => {
  const input = {
    ...recorded,
    workspaceId: "foreign",
    data: {
      ...recorded.data,
      event: {
        ...recorded.data.event,
        title: "secret-password",
        exception: { values: [{ value: "secret-password" }] },
        request: { headers: { Authorization: "Bearer secret-password" } },
        user: { email: "private@example.invalid" },
      },
    },
  };
  const signal = normalizeSentryIssueAlert(bytes(input));
  assert.equal("workspaceId" in signal, false);
  assert.equal(JSON.stringify(signal).includes("secret-password"), false);
  assert.equal(
    JSON.stringify(signal).includes("private@example.invalid"),
    false,
  );
});
test("unsupported notifications and invalid evidence are rejected rather than fabricated as recovery", () => {
  for (const action of ["resolved", "created", "deleted"])
    assert.throws(
      () => normalizeSentryIssueAlert(bytes({ ...recorded, action })),
      { code: "invalid_input" },
    );
  for (const change of [
    { datetime: "yesterday" },
    { event_id: "" },
    { project: -1 },
    { level: "healthy" },
  ])
    assert.throws(
      () =>
        normalizeSentryIssueAlert(
          bytes({
            ...recorded,
            data: { event: { ...recorded.data.event, ...change } },
          }),
        ),
      { code: "invalid_input" },
    );
});

test("signed sentry ingestion authenticates before parsing attacker input", () => {
  assert.throws(
    () => signedSentryIssueAlert(Buffer.from("{"), undefined, secret),
    { code: "invalid_token" },
  );
});
