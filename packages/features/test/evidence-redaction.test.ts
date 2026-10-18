import test from "node:test";
import assert from "node:assert/strict";
import {
  redactEvidence,
  redactEvidenceText,
} from "../src/investigation/evidence/redaction.js";
test("structured evidence masks credential fields without destroying safe facts", () => {
  const input = {
    status: 503,
    request: {
      authorization: "Bearer abc",
      headers: { cookie: "session=hidden" },
      apiKey: "hidden",
      message: "connection refused",
    },
    nested: [{ client_secret: "hidden", latency: 50 }],
  };
  const output = JSON.parse(redactEvidenceText(JSON.stringify(input)));
  assert.equal(output.status, 503);
  assert.equal(output.request.authorization, "[REDACTED]");
  assert.equal(output.request.headers.cookie, "[REDACTED]");
  assert.equal(output.request.apiKey, "[REDACTED]");
  assert.equal(output.request.message, "connection refused");
  assert.equal(output.nested[0].client_secret, "[REDACTED]");
  assert.equal(output.nested[0].latency, 50);
});
test("known values include literal, encoded and JSON escaped representations", () => {
  const secret = 'actual+key"value';
  const source = [
    secret,
    encodeURIComponent(secret),
    JSON.stringify(secret).slice(1, -1),
  ].join("\n");
  assert.equal(
    redactEvidenceText(source, [secret]),
    "[REDACTED]\n[REDACTED]\n[REDACTED]",
  );
});
test("matching never reprocesses replacement markers and treats regex syntax literally", () => {
  assert.equal(
    redactEvidenceText("R E a.*b", ["R", "E", "a.*b"]),
    "[REDACTED] [REDACTED] [REDACTED]",
  );
  assert.equal(redactEvidenceText("abcdef", ["abc", "abcdef"]), "[REDACTED]");
});
test("unstructured credential assignments and authorization values are removed", () => {
  const source =
    "safe error\npassword = do-not-expose\nauthorization:\nBearer another-secret\nrequest failed with Basic dXNlcjpwYXNz\nrecovered";
  const value = redactEvidenceText(source);
  assert.ok(value.includes("safe error"));
  assert.ok(value.includes("recovered"));
  for (const secret of ["do-not-expose", "another-secret", "dXNlcjpwYXNz"])
    assert.equal(value.includes(secret), false);
});
test("private keys and credential-bearing URLs are excluded", () => {
  const value = redactEvidenceText(
    "before\n-----BEGIN RSA PRIVATE KEY-----\nvery-secret\n-----END RSA PRIVATE KEY-----\nafter https://user:pass@example.com/p https://example.com/p?opaque=value https://example.com/p#value https://example.com/health",
  );
  for (const secret of ["very-secret", "user:pass", "opaque=value", "#value"])
    assert.equal(value.includes(secret), false);
  assert.ok(value.includes("https://example.com/health"));
  assert.ok(value.includes("before"));
  assert.ok(value.includes("after"));
  assert.equal(
    redactEvidenceText("-----BEGIN PRIVATE KEY-----\nunfinished"),
    "[REDACTED]",
  );
});
test("output size, nesting, node count and known-secret configuration stay bounded", () => {
  assert.throws(() => redactEvidenceText("x".repeat(262145)), TypeError);
  assert.throws(() => redactEvidenceText("ok", [""]), TypeError);
  assert.throws(
    () => redactEvidenceText("ok", Array(129).fill("x")),
    TypeError,
  );
  assert.throws(
    () => redactEvidenceText("ok", Array(5).fill("x".repeat(8192))),
    TypeError,
  );
  let object: unknown = "deep";
  for (let i = 0; i < 20; i++) object = { value: object };
  assert.ok(redactEvidenceText(JSON.stringify(object)).includes("[OMITTED]"));
  const values = JSON.parse(
    redactEvidenceText(JSON.stringify(Array(200).fill("safe"))),
  );
  assert.equal(values.length, 100);
});

test("known-value replacement cannot hide an assignment label before it is masked", () => {
  assert.equal(
    redactEvidenceText("password = actual-credential", ["password"]),
    "[REDACTED]",
  );
});

test("known URL-encoded values are masked regardless of escape hex case", () => {
  const secret = "ABC+Key/Value";
  assert.equal(
    redactEvidenceText(encodeURIComponent(secret).toLowerCase(), [secret]),
    "[REDACTED]",
  );
});

test("redaction distinguishes credential masking from content-size omissions", () => {
  assert.equal(
    redactEvidence('{"password":"hidden","status":503}').truncated,
    false,
  );
  assert.equal(
    redactEvidence(JSON.stringify(Array(101).fill("safe"))).truncated,
    true,
  );
  assert.equal(
    redactEvidence(
      JSON.stringify(
        Object.fromEntries(
          Array.from({ length: 101 }, (_, i) => ["field" + i, i]),
        ),
      ),
    ).truncated,
    true,
  );
  let deep: unknown = "safe";
  for (let i = 0; i < 15; i++) deep = { value: deep };
  assert.equal(redactEvidence(JSON.stringify(deep)).truncated, true);
});
