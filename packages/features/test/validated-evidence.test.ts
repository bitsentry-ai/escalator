import test from "node:test";
import assert from "node:assert/strict";
import {
  investigationScopeSchema,
  evidenceQuerySchema,
  type InvestigationEvidence,
} from "../src/contracts/index.js";
import { ValidatedEvidenceReader } from "../src/investigation/evidence/validated-reader.js";
import type { EvidenceReader } from "../src/investigation/ports/index.js";
const scope = investigationScopeSchema.parse({
  workspaceId: "org_a",
  serviceId: "service_a",
  environmentId: "production",
  incidentId: "incident_a",
});
const query = evidenceQuerySchema.parse({
  kind: "log",
  sourceId: "source_a",
  window: { from: "2026-10-01T00:00:00.000Z", to: "2026-10-01T01:00:00.000Z" },
  limit: 2,
});
function evidence(): InvestigationEvidence {
  return {
    scope: structuredClone(scope),
    reference: {
      id: "evidence_a",
      kind: "log",
      sourceId: "source_a",
      observedAt: "2026-10-01T00:30:00.000Z",
      receivedAt: "2026-10-01T00:31:00.000Z",
    },
    collectedAt: "2026-10-01T01:01:00.000Z",
    window: structuredClone(query.window),
    text: "Redacted service error",
    truncated: false,
  };
}
const context = () => ({
  signal: new AbortController().signal,
  timeoutMs: 1000,
  maxBytes: 4096,
});
const result = (items = [evidence()]) => ({
  status: "available" as const,
  items,
  truncated: false,
});
const unavailable = (reason: string) => ({
  status: "unavailable",
  unavailable: { query, reason },
});
const reader = (value: unknown) =>
  new ValidatedEvidenceReader({ read: async () => value } as EvidenceReader);
test("validated evidence retains provenance and returns an independent snapshot", async () => {
  const raw = result();
  const actual = await reader(raw).read(scope, query, context());
  assert.deepEqual(actual, raw);
  raw.items[0].text = "changed";
  assert.notDeepEqual(actual, raw);
});
test("all scope axes and source/kind bindings must match", async () => {
  for (const axis of [
    "workspaceId",
    "serviceId",
    "environmentId",
    "incidentId",
  ] as const) {
    const item = evidence();
    Object.assign(item.scope, { [axis]: "other" });
    assert.deepEqual(
      await reader(result([item])).read(scope, query, context()),
      unavailable("invalid_response"),
    );
  }
  for (const field of ["sourceId", "kind"] as const) {
    const item = evidence();
    Object.assign(item.reference, {
      [field]: field === "kind" ? "metric" : "other",
    });
    assert.deepEqual(
      await reader(result([item])).read(scope, query, context()),
      unavailable("invalid_response"),
    );
  }
});
test("wrong windows, future receipt, empty text and duplicate IDs are rejected", async () => {
  const cases: Array<(item: InvestigationEvidence) => void> = [
    (i) => (i.window.to = "2026-10-01T02:00:00.000Z"),
    (i) => (i.reference.observedAt = "2026-09-30T23:59:00.000Z"),
    (i) => (i.reference.receivedAt = "2026-10-02T00:00:00.000Z"),
    (i) => (i.text = " "),
  ];
  for (const mutate of cases) {
    const item = evidence();
    mutate(item);
    assert.deepEqual(
      await reader(result([item])).read(scope, query, context()),
      unavailable("invalid_response"),
    );
  }
  assert.deepEqual(
    await reader(result([evidence(), evidence()])).read(
      scope,
      query,
      context(),
    ),
    unavailable("invalid_response"),
  );
});
test("empty success and invalid source unavailable queries remain explicit", async () => {
  assert.deepEqual(
    await reader(result([])).read(scope, query, context()),
    unavailable("not_found"),
  );
  assert.deepEqual(
    await reader(unavailable("not_authorized")).read(scope, query, context()),
    unavailable("not_authorized"),
  );
  const wrong = unavailable("not_found");
  wrong.unavailable.query = { ...query, sourceId: "other" };
  assert.deepEqual(
    await reader(wrong).read(scope, query, context()),
    unavailable("invalid_response"),
  );
});
test("serialized metadata and UTF8 bytes count toward the response budget", async () => {
  const item = evidence();
  item.text = "é".repeat(500);
  const value = result([item]);
  const exact = Buffer.byteLength(JSON.stringify(value.items));
  assert.deepEqual(
    await reader(value).read(scope, query, { ...context(), maxBytes: exact }),
    value,
  );
  assert.deepEqual(
    await reader(value).read(scope, query, {
      ...context(),
      maxBytes: exact - 1,
    }),
    unavailable("budget_exhausted"),
  );
});
test("request snapshots cannot be widened by caller or adapter mutation", async () => {
  const originalScope = structuredClone(scope),
    originalQuery = structuredClone(query);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const r = new ValidatedEvidenceReader({
    read: async (s, q) => {
      Object.assign(s, { workspaceId: "other" });
      q.window.to = "2026-10-01T05:00:00.000Z";
      await gate;
      return result();
    },
  });
  const pending = r.read(originalScope, originalQuery, context());
  Object.assign(originalScope, { workspaceId: "attacker" });
  originalQuery.sourceId = "attacker";
  release();
  assert.deepEqual(await pending, result());
});
test("already cancelled reads never invoke the host adapter", async () => {
  let called = false;
  const controller = new AbortController();
  controller.abort();
  const r = new ValidatedEvidenceReader({
    read: async () => {
      called = true;
      return result();
    },
  });
  assert.deepEqual(
    await r.read(scope, query, { ...context(), signal: controller.signal }),
    unavailable("cancelled"),
  );
  assert.equal(called, false);
});
test("noncooperative reads are timed out and their signal is aborted", async () => {
  let signal: AbortSignal | undefined;
  const r = new ValidatedEvidenceReader({
    read: (_s, _q, c) => {
      signal = c.signal;
      return new Promise(() => {});
    },
  });
  assert.deepEqual(
    await r.read(scope, query, { ...context(), timeoutMs: 50 }),
    unavailable("timeout"),
  );
  assert.equal(signal?.aborted, true);
});
test("provider exceptions are sanitized and malformed results fail closed", async () => {
  const r = new ValidatedEvidenceReader({
    read: async () => {
      throw new Error("secret-do-not-expose");
    },
  });
  assert.deepEqual(
    await r.read(scope, query, context()),
    unavailable("unreachable"),
  );
  for (const value of [
    null,
    {
      status: "available",
      items: [evidence()],
      truncated: false,
      secret: "value",
    },
    { status: "unavailable", unavailable: { query, reason: "invented" } },
  ])
    assert.deepEqual(
      await reader(value).read(scope, query, context()),
      unavailable("invalid_response"),
    );
});
test("row limits and numeric operation limits cannot be widened", async () => {
  const rows = [evidence(), evidence(), evidence()];
  rows.forEach((item, i) => (item.reference.id = "evidence_" + i));
  assert.deepEqual(
    await reader(result(rows)).read(scope, query, context()),
    unavailable("invalid_response"),
  );
  for (const maxBytes of [0, -1, 1.5, 262145, Number.NaN])
    await assert.rejects(
      reader(result()).read(scope, query, { ...context(), maxBytes }),
      TypeError,
    );
  for (const timeoutMs of [0, -1, 0.5, 120001, Number.NaN])
    await assert.rejects(
      reader(result()).read(scope, query, { ...context(), timeoutMs }),
      TypeError,
    );
});
test("cancellation wins over a late adapter response", async () => {
  let release!: (value: ReturnType<typeof result>) => void;
  const controller = new AbortController();
  const r = new ValidatedEvidenceReader({
    read: () => new Promise((resolve) => (release = resolve)),
  });
  const pending = r.read(scope, query, {
    ...context(),
    signal: controller.signal,
  });
  await Promise.resolve();
  controller.abort();
  assert.deepEqual(await pending, unavailable("cancelled"));
  release(result());
  await Promise.resolve();
});

test("redaction happens before returning evidence and fails closed", async () => {
  const item = evidence();
  item.text = "authorization: Bearer must-not-leak";
  const actual = await reader(result([item])).read(scope, query, context());
  assert.equal(actual.status, "available");
  if (actual.status === "available")
    assert.equal(actual.items[0].text, "[REDACTED]");
  const bad = new ValidatedEvidenceReader(
    { read: async () => result() },
    () => {
      throw new Error("redactor internal secret");
    },
  );
  assert.deepEqual(
    await bad.read(scope, query, context()),
    unavailable("invalid_response"),
  );
  const oversized = new ValidatedEvidenceReader(
    { read: async () => result() },
    () => ({ text: "x".repeat(16385), truncated: false }),
  );
  assert.deepEqual(
    await oversized.read(scope, query, context()),
    unavailable("invalid_response"),
  );
});

test("item-level truncation stays visible on the batch outcome", async () => {
  const item = evidence();
  item.truncated = true;
  const actual = await reader(result([item])).read(scope, query, context());
  assert.equal(actual.status, "available");
  if (actual.status === "available") assert.equal(actual.truncated, true);
});

test("cancellation during redaction cannot return usable evidence", async () => {
  const controller = new AbortController();
  const r = new ValidatedEvidenceReader(
    { read: async () => result() },
    (text) => {
      controller.abort();
      return { text, truncated: false };
    },
  );
  assert.deepEqual(
    await r.read(scope, query, { ...context(), signal: controller.signal }),
    unavailable("cancelled"),
  );
});
test("size omissions from redaction propagate to item and batch truncation", async () => {
  const item = evidence();
  item.text = JSON.stringify(Array(101).fill("safe"));
  const actual = await reader(result([item])).read(scope, query, context());
  assert.equal(actual.status, "available");
  if (actual.status === "available") {
    assert.equal(actual.truncated, true);
    assert.equal(actual.items[0].truncated, true);
    assert.equal(JSON.parse(actual.items[0].text).length, 100);
  }
});
