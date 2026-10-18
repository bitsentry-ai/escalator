import test from "node:test";
import assert from "node:assert/strict";
import {
  investigationScopeSchema,
  evidenceQuerySchema,
} from "../src/contracts/index.js";
import {
  prepareWazuhEvidence,
  normalizeWazuhEvidence,
  WazuhEvidenceError,
  type WazuhEvidenceBinding,
} from "../src/investigation/evidence/wazuh.js";
const scope = investigationScopeSchema.parse({
  workspaceId: "org_a",
  serviceId: "api",
  environmentId: "production",
  incidentId: "incident_1",
});
const query = evidenceQuerySchema.parse({
  kind: "log",
  sourceId: "source_1",
  window: { from: "2026-10-01T00:00:00.000Z", to: "2026-10-01T01:00:00.000Z" },
  limit: 2,
});
const binding: WazuhEvidenceBinding = {
  scope,
  sourceId: query.sourceId,
  sourceName: "Wazuh",
  revision: 1,
  agentIds: ["001"],
  indexPattern: "wazuh-alerts-*",
  timestampField: "@timestamp",
};
const collected = "2026-10-01T01:01:00.000Z";
function hit() {
  return {
    _id: "event-1",
    _index: "wazuh-alerts-2026.10.01",
    _source: {
      "@timestamp": "2026-10-01T00:30:00.000Z",
      agent: { id: "001" },
      rule: { id: "5710", level: 10, description: "Service error" },
      full_log: "Connection refused",
      decoder: { name: "web-accesslog" },
      data: { id: "503", protocol: "GET", url: "/health", srcip: "192.0.2.1" },
    },
  };
}
function normalize(
  items: unknown[] = [{ rawAlert: hit() }],
  override: Partial<WazuhEvidenceBinding> = {},
) {
  return normalizeWazuhEvidence(
    scope,
    query,
    { ...binding, ...override },
    { items, hasMore: false },
    collected,
  );
}
const failure = (reason: string) => (error: unknown) =>
  error instanceof WazuhEvidenceError && error.reason === reason;
test("operational Wazuh queries contain only the configured time and agent selectors", () => {
  const value = prepareWazuhEvidence(scope, query, {
    ...binding,
    agentIds: ["001", "002", "001"],
  });
  assert.equal(
    value.search,
    '@timestamp:[2026-10-01T00:00:00.000Z TO 2026-10-01T01:00:00.000Z] AND agent.id:("001" OR "002")',
  );
  assert.notEqual(value.binding, binding);
});
test("binding mismatches and selector injection fail before a query is formed", () => {
  for (const key of [
    "workspaceId",
    "serviceId",
    "environmentId",
    "incidentId",
  ] as const)
    assert.throws(
      () =>
        prepareWazuhEvidence(scope, query, {
          ...binding,
          scope: { ...scope, [key]: "other" },
        }),
      failure("not_authorized"),
    );
  for (const override of [
    { sourceId: "other" },
    { agentIds: [] },
    { agentIds: ['001" OR *'] },
    { indexPattern: "http://other" },
    { revision: 0 },
  ])
    assert.throws(
      () => prepareWazuhEvidence(scope, query, { ...binding, ...override }),
      failure("not_authorized"),
    );
  assert.throws(
    () => prepareWazuhEvidence(scope, { ...query, kind: "metric" }, binding),
    failure("not_authorized"),
  );
});
test("Wazuh projection preserves scoped references and records retrieval availability honestly", () => {
  const result = normalize();
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  const item = result.items[0];
  assert.deepEqual(item.scope, scope);
  assert.deepEqual(item.window, query.window);
  assert.equal(item.reference.sourceId, query.sourceId);
  assert.equal(item.reference.observedAt, "2026-10-01T00:30:00.000Z");
  assert.equal(item.reference.receivedAt, collected);
  assert.equal(item.collectedAt, collected);
  assert.match(item.reference.id, /^wazuh:[0-9a-f]{64}$/);
  const projected = JSON.parse(item.text);
  assert.equal(projected.rule.description, "Service error");
  assert.equal(projected.http.status, 503);
  assert.equal(projected.http.method, "GET");
  assert.equal(projected.message, "Connection refused");
  assert.deepEqual(normalize([hit()]), result);
});
test("only explicitly selected fields reach evidence and log credentials are masked", () => {
  const raw = hit();
  Object.assign(raw._source, {
    headers: { authorization: "never-copy-header" },
    password: "never-copy-password",
  });
  raw._source.full_log = "password=never-copy-log-secret";
  const result = normalize([{ rawAlert: raw }]);
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  for (const value of [
    "never-copy-header",
    "never-copy-password",
    "never-copy-log-secret",
  ])
    assert.equal(result.items[0].text.includes(value), false);
  assert.ok(result.items[0].text.includes("[REDACTED]"));
});
test("agent, index, timestamp and duplicate checks reject out-of-scope provider rows", () => {
  const agent = hit();
  agent._source.agent.id = "002";
  const index = hit();
  index._index = "another-tenant";
  const early = hit();
  early._source["@timestamp"] = "2026-09-30T00:00:00.000Z";
  for (const raw of [agent, index, early])
    assert.throws(() => normalize([raw]), failure("invalid_response"));
  assert.throws(() => normalize([hit(), hit()]), failure("invalid_response"));
  assert.throws(
    () => normalize([{ id: "only-a-title", title: "insufficient provenance" }]),
    failure("invalid_response"),
  );
});
test("bounded wildcard matching respects literal index names and question marks", () => {
  assert.equal(
    normalize([hit()], { indexPattern: "wazuh-alerts-2026.10.0?" }).status,
    "available",
  );
  assert.equal(
    normalize([hit()], { indexPattern: "wazuh-***alerts-*" }).status,
    "available",
  );
  assert.throws(
    () => normalize([hit()], { indexPattern: "wazuh-alerts-2026.10.02" }),
    failure("invalid_response"),
  );
  assert.throws(
    () => normalize([hit()], { indexPattern: "wazuhXalerts*" }),
    failure("invalid_response"),
  );
});
test("configured timestamp fields and explicit offsets normalize without guessing missing time", () => {
  const raw = hit();
  raw._source["@timestamp"] = "2026-10-01T07:30:00+0700";
  const value = normalize([raw]);
  assert.equal(value.status, "available");
  if (value.status === "available")
    assert.equal(
      value.items[0].reference.observedAt,
      "2026-10-01T00:30:00.000Z",
    );
  assert.throws(
    () => normalize([raw], { timestampField: "timestamp" }),
    failure("invalid_response"),
  );
  const timestamp = {
    ...raw,
    _source: { ...raw._source, timestamp: "2026-10-01T00:30:00Z" },
  };
  assert.equal(
    normalize([timestamp], { timestampField: "timestamp" }).status,
    "available",
  );
  raw._source["@timestamp"] = "not-a-date";
  assert.throws(() => normalize([raw]), failure("invalid_response"));
});
test("oversized log and URL fields are omitted whole with explicit truncation", () => {
  const raw = hit();
  raw._source.full_log = "sensitive-prefix-" + "x".repeat(9000);
  raw._source.data.url = "https://user:secret@example.com/" + "x".repeat(3000);
  const result = normalize([raw]);
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.truncated, true);
  assert.equal(result.items[0].truncated, true);
  assert.equal(result.items[0].text.includes("sensitive-prefix"), false);
  assert.equal(result.items[0].text.includes("user:secret"), false);
  assert.equal(JSON.parse(result.items[0].text).http.status, 503);
});
test("empty, excess and partial result sets remain explicit", () => {
  assert.deepEqual(normalize([]), {
    status: "unavailable",
    unavailable: { query, reason: "not_found" },
  });
  assert.throws(
    () => normalize([hit(), hit(), hit()]),
    failure("invalid_response"),
  );
  const result = normalizeWazuhEvidence(
    scope,
    query,
    binding,
    { items: [hit()], hasMore: true },
    collected,
  );
  assert.equal(result.status, "available");
  if (result.status === "available") assert.equal(result.truncated, true);
});
test("evidence identifiers are stable for one snapshot and distinguish later retrievals", () => {
  const a = normalize();
  const b = normalizeWazuhEvidence(
    scope,
    query,
    binding,
    { items: [hit()], hasMore: false },
    "2026-10-01T01:02:00.000Z",
  );
  assert.equal(a.status, "available");
  assert.equal(b.status, "available");
  if (a.status === "available" && b.status === "available")
    assert.notEqual(a.items[0].reference.id, b.items[0].reference.id);
  assert.throws(
    () =>
      normalizeWazuhEvidence(
        scope,
        query,
        binding,
        { items: [hit()], hasMore: false },
        "2026-10-01T00:01:00.000Z",
      ),
    failure("invalid_response"),
  );
});

test("relative and protocol-relative HTTP URLs cannot disclose query values or credentials", () => {
  for (const url of [
    "/health?opaque=private-value",
    "/health#private-value",
    "//user:private-value@example.com/path",
    "javascript:private-value",
    "http://[",
  ]) {
    const raw = hit();
    raw._source.data.url = url;
    const result = normalize([raw]);
    assert.equal(result.status, "available");
    if (result.status === "available") {
      assert.equal(JSON.parse(result.items[0].text).http.url, "[URL REDACTED]");
      assert.equal(result.items[0].text.includes("private-value"), false);
    }
  }
});
