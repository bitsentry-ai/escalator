import test from "node:test";
import assert from "node:assert/strict";
import { readSourceForm, readProviderForm } from "../src/ui/sources/form.js";
import { signalSourceSchema } from "../src/contracts/index.js";
function form(values: Record<string, string> = {}) {
  const data = new FormData();
  for (const [key, value] of Object.entries({
    name: "Errors",
    service: "api",
    environment: "production",
    mode: "generic",
    grouping: "source-fingerprint",
    recovery: "explicit",
    hold: "60",
    ...values,
  }))
    data.set(key, value);
  return data;
}
const source = signalSourceSchema.parse({
  id: "source",
  workspaceId: "workspace",
  serviceId: "api",
  environmentId: "production",
  name: "Errors",
  kind: "grafana",
  grouping: "source-fingerprint",
  recovery: "explicit",
  recoveryHoldSeconds: 60,
  enabled: true,
  version: 7,
  authSecretId: "old",
  intake: { mode: "grafana-hmac" },
  createdAt: "2026-10-03T00:00:00.000Z",
  updatedAt: "2026-10-03T00:00:00.000Z",
});
test("source creation supports generic and signed intake without accepting caller scope", () => {
  const generic = readSourceForm(
    form({ workspaceId: "foreign", token: "ignored" }),
  );
  assert.equal(generic.kind, "generic");
  assert.equal("workspaceId" in generic.input, false);
  assert.equal("token" in generic.input, false);
  const signed = readSourceForm(
    form({ mode: "sentry-hmac", authSecretId: "signing" }),
  );
  assert.equal(signed.kind, "provider");
  if (signed.kind !== "provider") throw new Error("Expected provider");
  assert.deepEqual(signed.input.intake, { mode: "sentry-hmac" });
  assert.equal(signed.input.authSecretId, "signing");
  assert.throws(() => readSourceForm(form({ mode: "sentry-hmac" })));
});
test("provider forms retain authenticated selection identity and version", () => {
  const edited = readSourceForm(
    form({ id: "foreign", expectedVersion: "999", enabled: "on" }),
    source,
  );
  assert.equal(edited.kind, "update");
  if (edited.kind !== "update") throw new Error("Expected update");
  assert.equal(edited.input.id, "source");
  assert.equal(edited.input.expectedVersion, 7);
  const provider = readProviderForm(
    form({ authSecretId: "new", mode: "grafana-bearer", id: "foreign" }),
    source,
  );
  assert.deepEqual(provider.intake, { mode: "grafana-hmac" });
  assert.equal(provider.authSecretId, "new");
  assert.equal(provider.expectedVersion, 7);
});
test("source forms reject unbounded holds, unsupported modes and tracker credentials", () => {
  assert.throws(() => readSourceForm(form({ hold: "86401" })));
  assert.throws(() => readSourceForm(form({ mode: "unknown" })));
  assert.throws(() =>
    readSourceForm(
      form({ mode: "glitchtip", origin: "https://user:password@example.com" }),
    ),
  );
  const token = readSourceForm(
    form({ mode: "grafana-bearer", authSecretId: "ignored" }),
  );
  if (token.kind !== "provider") throw new Error("Expected provider");
  assert.equal(token.input.authSecretId, null);
});
