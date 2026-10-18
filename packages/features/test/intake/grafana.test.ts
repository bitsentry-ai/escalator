import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  normalizeGrafanaAlerts,
  verifyGrafanaSignature,
  signedGrafanaAlerts,
} from "../../src/adapters/intake/grafana-alerts.js";
const secret = Buffer.from("a-test-only-grafana-secret");
const timestamp = "1790942400";
const now = Number(timestamp) * 1000;
const alert = {
  status: "firing",
  fingerprint: "c6eadffa33fcdf37",
  startsAt: "2021-10-12T09:51:03.157076+02:00",
  endsAt: "0001-01-01T00:00:00Z",
  labels: { severity: "critical", private: "sensitive" },
};
const body = (alerts = [alert]) =>
  Buffer.from(
    JSON.stringify({
      version: "1",
      status: "firing",
      truncatedAlerts: 0,
      alerts,
    }),
  );
test("Grafana signs timestamp colon raw body and rejects expiry, future dates or tampering", () => {
  const data = body();
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}:`)
    .update(data)
    .digest("hex");
  assert.equal(
    verifyGrafanaSignature(data, signature, timestamp, secret, now),
    true,
  );
  assert.equal(
    verifyGrafanaSignature(data, signature, timestamp, secret, now + 300_001),
    false,
  );
  assert.equal(
    verifyGrafanaSignature(data, signature, timestamp, secret, now - 300_001),
    false,
  );
  assert.equal(
    verifyGrafanaSignature(
      Buffer.from("{}"),
      signature,
      timestamp,
      secret,
      now,
    ),
    false,
  );
  assert.equal(
    verifyGrafanaSignature(
      data,
      signature,
      String(Number(timestamp) + 1),
      secret,
      now,
    ),
    false,
  );
  assert.equal(
    verifyGrafanaSignature(data, signature, undefined, secret, now),
    false,
  );
  assert.equal(
    verifyGrafanaSignature(data, "bad", timestamp, secret, now),
    false,
  );
});
test("individual firing and resolved alerts take precedence over a firing group summary", () => {
  const events = normalizeGrafanaAlerts(
    body([
      alert,
      {
        ...alert,
        fingerprint: "bc97ff14869b13e3",
        status: "resolved",
        endsAt: "2021-10-12T10:00:00+02:00",
      },
    ]),
  );
  assert.deepEqual(
    events.map((event) => event.status),
    ["active", "recovered"],
  );
  assert.equal(events[0].observedAt, "2021-10-12T07:51:03.157Z");
  assert.equal(events[1].observedAt, "2021-10-12T08:00:00.000Z");
  assert.equal(events[0].severity, "critical");
  assert.equal(JSON.stringify(events).includes("sensitive"), false);
});
test("occurrence IDs distinguish recovery and later firing while repeated notifications deduplicate", () => {
  const first = normalizeGrafanaAlerts(body())[0];
  assert.equal(normalizeGrafanaAlerts(body([alert, alert])).length, 1);
  const resolved = normalizeGrafanaAlerts(
    body([
      { ...alert, status: "resolved", endsAt: "2021-10-12T10:00:00+02:00" },
    ]),
  )[0];
  const later = normalizeGrafanaAlerts(
    body([{ ...alert, startsAt: "2021-10-12T11:00:00+02:00" }]),
  )[0];
  assert.equal(first.fingerprint, resolved.fingerprint);
  assert.equal(first.fingerprint, later.fingerprint);
  assert.notEqual(first.eventId, resolved.eventId);
  assert.notEqual(first.eventId, later.eventId);
});
test("truncated, empty, or impossible recovery payloads cannot claim health", () => {
  const truncated = JSON.parse(body().toString());
  truncated.truncatedAlerts = 1;
  assert.throws(
    () => normalizeGrafanaAlerts(Buffer.from(JSON.stringify(truncated))),
    { code: "invalid_input" },
  );
  assert.throws(() => normalizeGrafanaAlerts(body([])), {
    code: "invalid_input",
  });
  assert.throws(
    () => normalizeGrafanaAlerts(body([{ ...alert, status: "resolved" }])),
    { code: "invalid_input" },
  );
});

test("signed grafana ingestion authenticates before parsing attacker input", () => {
  assert.throws(
    () =>
      signedGrafanaAlerts(Buffer.from("{"), undefined, timestamp, secret, now),
    { code: "invalid_token" },
  );
});
