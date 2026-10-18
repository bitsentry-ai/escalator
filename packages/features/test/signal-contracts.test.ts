import test from "node:test";
import assert from "node:assert/strict";
import {
  signalInputSchema,
  signalSourceSchema,
  signalTokenSchema,
} from "../src/contracts/index.js";

const input = {
  version: 1,
  eventId: "event:123",
  fingerprint: "route /checkout",
  observedAt: "2026-09-20T00:00:00.000Z",
  status: "active",
  severity: "critical",
  title: "Checkout failed",
  evidence: {
    summary: "HTTP 500",
    attributes: [{ name: "status", value: "500" }],
  },
};
test("machine input cannot select tenant, source, service or received time", () => {
  assert.equal(signalInputSchema.safeParse(input).success, true);
  for (const [key, value] of Object.entries({
    workspaceId: "foreign",
    sourceId: "foreign",
    serviceId: "foreign",
    environmentId: "foreign",
    receivedAt: input.observedAt,
  }))
    assert.equal(
      signalInputSchema.safeParse({ ...input, [key]: value }).success,
      false,
      key,
    );
});
test("signal status and version are explicit; absence cannot imply recovery", () => {
  assert.equal(
    signalInputSchema.safeParse({ ...input, status: "recovered" }).success,
    true,
  );
  for (const patch of [
    { status: undefined },
    { status: "healthy" },
    { version: 2 },
    { observedAt: "2026-09-20" },
  ])
    assert.equal(
      signalInputSchema.safeParse({ ...input, ...patch }).success,
      false,
    );
});
test("source event identifiers are retained exactly and cannot contain control characters", () => {
  assert.equal(
    signalInputSchema.parse({ ...input, eventId: "provider/event:123" })
      .eventId,
    "provider/event:123",
  );
  for (const eventId of ["", "a\nb", "x".repeat(257)])
    assert.equal(
      signalInputSchema.safeParse({ ...input, eventId }).success,
      false,
    );
});
test("bounded evidence rejects arbitrary payloads, excess attributes and duplicate keys", () => {
  for (const evidence of [
    { ...input.evidence, rawPayload: { authorization: "secret" } },
    { ...input.evidence, summary: "x".repeat(4001) },
    {
      ...input.evidence,
      attributes: Array.from({ length: 17 }, (_, i) => ({
        name: `key${i}`,
        value: "x",
      })),
    },
    {
      ...input.evidence,
      attributes: [
        { name: "status", value: "500" },
        { name: "status", value: "200" },
      ],
    },
    {
      ...input.evidence,
      attributes: [{ name: "status", value: "x".repeat(1001) }],
    },
  ])
    assert.equal(
      signalInputSchema.safeParse({ ...input, evidence }).success,
      false,
    );
});
const source = {
  id: "source",
  workspaceId: "workspace",
  serviceId: "service",
  environmentId: "production",
  name: "Checkout errors",
  kind: "generic",
  enabled: true,
  version: 1,
  grouping: "source-fingerprint",
  recovery: "explicit",
  recoveryHoldSeconds: 60,
  authSecretId: null,
  createdAt: input.observedAt,
  updatedAt: input.observedAt,
};
test("source recovery and grouping require explicit bounded configuration", () => {
  assert.equal(signalSourceSchema.safeParse(source).success, true);
  for (const patch of [
    { grouping: "service" },
    { recovery: "silence" },
    { recoveryHoldSeconds: -1 },
    { recoveryHoldSeconds: 86_401 },
    { version: 0 },
    { updatedAt: "2026-09-19T00:00:00.000Z" },
  ])
    assert.equal(
      signalSourceSchema.safeParse({ ...source, ...patch }).success,
      false,
    );
});
const token = {
  id: "grant",
  workspaceId: "workspace",
  sourceId: "source",
  scope: "signal:write",
  tokenHash: "a".repeat(64),
  createdAt: input.observedAt,
  expiresAt: "2026-09-21T00:00:00.000Z",
  revokedAt: null,
};
test("machine grants persist a hash and cannot widen scope or accept raw tokens", () => {
  assert.equal(signalTokenSchema.safeParse(token).success, true);
  for (const patch of [
    { tokenHash: "raw-token" },
    { scope: "workspace:manage" },
    { token: "raw-token" },
    { expiresAt: token.createdAt },
    { revokedAt: "2026-09-19T00:00:00.000Z" },
  ])
    assert.equal(
      signalTokenSchema.safeParse({ ...token, ...patch }).success,
      false,
    );
});
