import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MonitoringCredentialForm } from "../src/ui/monitoring/MonitoringCredentialForm.js";
import { MonitoringSecretPicker } from "../src/ui/monitoring/MonitoringSecretPicker.js";
import type { MonitoringSecretsClient } from "../src/ui/monitoring-client.js";
const t = (key: string) => key;
test("Dashboard without a credential writer renders guidance and never a secret input", () => {
  const html = renderToStaticMarkup(
    createElement(MonitoringCredentialForm, {
      client: {} as MonitoringSecretsClient,
      kind: "provider-signing",
      t,
      onCreated() {
        throw new Error("Rendering must not write");
      },
    }),
  );
  assert.match(html, /monitoring.externalCredentials/);
  assert.doesNotMatch(html, /<form|<input|type="password"/);
});
test("standalone credential fields are write-only, bounded and tailored to the selected format", () => {
  const client: MonitoringSecretsClient = {
    async secretOptions() {
      throw new Error("Rendering must not fetch");
    },
    async createMonitoringSecret() {
      throw new Error("Rendering must not write");
    },
  };
  for (const kind of ["http-probe", "metrics", "provider-signing"] as const) {
    const html = renderToStaticMarkup(
      createElement(MonitoringCredentialForm, {
        client,
        kind,
        t,
        onCreated() {},
      }),
    );
    assert.match(html, /type="password"/);
    assert.match(html, /autoComplete="off"/);
    assert.match(html, /monitoring.writeOnly/);
    assert.match(
      html,
      kind === "provider-signing" ? /maxLength="4096"/ : /maxLength="8192"/,
    );
    assert.equal(html.includes("<select"), kind === "http-probe");
    assert.doesNotMatch(html, /textarea/);
  }
});
test("loading credential metadata preserves the saved reference and escapes its display", () => {
  const value = 'reference"><script>';
  const html = renderToStaticMarkup(
    createElement(MonitoringSecretPicker, {
      client: {} as MonitoringSecretsClient,
      name: "authSecretId",
      value,
      t,
      onChange() {
        throw new Error("Rendering must not change selection");
      },
    }),
  );
  assert.match(html, /<select[^>]*disabled/);
  assert.match(html, /type="hidden" name="authSecretId"/);
  assert.match(html, /monitoring.retainedReference/);
  assert.doesNotMatch(html, /<script>/);
});
