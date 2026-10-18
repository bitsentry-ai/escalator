import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeGlitchTipAlert,
  glitchTipIngestionToken,
} from "../../src/adapters/intake/glitchtip.js";
const delivery = {
  deliveryId: "persisted-receipt",
  receivedAt: "2026-10-02T12:00:00.000Z",
  trackerOrigin: "https://errors.example.invalid",
};
// Synthetic fixture following the native send_issues_as_webhook attachment shape.
const payload = {
  text: "GlitchTip Alert (2 issues)",
  attachments: [1, 2].map((id) => ({
    title: "Private exception message",
    title_link: `https://errors.example.invalid/team/issues/${id}`,
    text: "private culprit",
    color: "#E52B50",
    fields: [{ title: "Project", value: "Project A", short: true }],
  })),
};
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
test("native GlitchTip attachments map to separate active observations without private evidence", () => {
  const signals = normalizeGlitchTipAlert(bytes(payload), delivery);
  assert.equal(signals.length, 2);
  assert.notEqual(signals[0].fingerprint, signals[1].fingerprint);
  for (const signal of signals) {
    assert.equal(signal.status, "active");
    assert.equal(signal.observedAt, delivery.receivedAt);
    assert.equal(
      signal.evidence.attributes.find((item) => item.name === "time_basis")
        ?.value,
      "received",
    );
  }
  assert.equal(JSON.stringify(signals).includes("private"), false);
  assert.equal(JSON.stringify(signals).includes("Private"), false);
});
test("receipt identity deduplicates retries without permanently suppressing identical future notifications", () => {
  const first = normalizeGlitchTipAlert(bytes(payload), delivery);
  assert.deepEqual(normalizeGlitchTipAlert(bytes(payload), delivery), first);
  const later = normalizeGlitchTipAlert(bytes(payload), {
    ...delivery,
    deliveryId: "another-persisted-receipt",
  });
  assert.equal(first[0].fingerprint, later[0].fingerprint);
  assert.notEqual(first[0].eventId, later[0].eventId);
  const duplicate = {
    ...payload,
    attachments: [payload.attachments[0], payload.attachments[0]],
  };
  assert.equal(normalizeGlitchTipAlert(bytes(duplicate), delivery).length, 1);
});
test("issue links are restricted to the configured tracker, without credentials or query data", () => {
  for (const title_link of [
    "https://foreign.example.invalid/team/issues/1",
    "https://user:pass@errors.example.invalid/team/issues/1",
    "https://errors.example.invalid/team/issues/1?token=private",
    "https://errors.example.invalid/team/issues/1#private",
    "https://errors.example.invalid/not-an-issue",
  ])
    assert.throws(
      () =>
        normalizeGlitchTipAlert(
          bytes({ ...payload, attachments: [{ title_link }] }),
          delivery,
        ),
      { code: "invalid_input" },
    );
  assert.throws(
    () =>
      normalizeGlitchTipAlert(
        bytes({ text: "empty", attachments: [] }),
        delivery,
      ),
    { code: "invalid_input" },
  );
});

test("native Basic credentials yield only a canonical scoped token for later authorization", () => {
  const token = `esi_${Buffer.alloc(32, 1).toString("base64url")}`;
  const basic = (value: string) =>
    `Basic ${Buffer.from(value).toString("base64")}`;
  assert.equal(glitchTipIngestionToken(basic(`escalator:${token}`)), token);
  assert.equal(glitchTipIngestionToken(`Bearer ${token}`), token);
  for (const authorization of [
    undefined,
    basic(`foreign:${token}`),
    basic(`escalator:${token}:extra`),
    "Basic !!!",
    `${basic(`escalator:${token}`)}=`,
    `Bearer ${token},other`,
  ])
    assert.equal(glitchTipIngestionToken(authorization), undefined);
});
