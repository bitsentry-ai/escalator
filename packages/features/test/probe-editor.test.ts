import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProbeEditor } from "../src/ui/probes/ProbeEditor.js";
import { probeSchema } from "../src/contracts/index.js";
import type { ProbesClient } from "../src/ui/probes-client.js";
const probe = probeSchema.parse({
  id: "probe",
  sourceId: "source",
  workspaceId: "workspace",
  serviceId: "service",
  environmentId: "production",
  name: '<img src=x onerror="alert(1)">',
  version: 7,
  enabled: true,
  critical: false,
  intervalSeconds: 60,
  failureThreshold: 2,
  recoveryThreshold: 2,
  createdAt: "2026-10-03T00:00:00.000Z",
  updatedAt: "2026-10-03T00:00:00.000Z",
  config: {
    method: "GET",
    url: "https://example.com/health",
    body: null,
    authSecretId: null,
    timeoutMs: 5000,
    maxResponseBytes: 65536,
    assertions: { status: [200], contains: null, json: [] },
    syntheticWrite: null,
  },
});
function render(canManage: boolean) {
  return renderToStaticMarkup(
    createElement(ProbeEditor, {
      client: {} as ProbesClient,
      initial: probe,
      services: [],
      environments: [],
      canManage,
      t: (key) => key,
      onSaved: () => {
        throw new Error("Rendering must not write");
      },
    }),
  );
}
test("read-only probe details escape configured names and expose no write actions", () => {
  const html = render(false);
  assert.match(html, /<fieldset[^>]*disabled/);
  assert.doesNotMatch(html, /<img|type="submit"|probes\.disable</);
  assert.match(html, /&lt;img/);
  assert.match(html, /probes\.version/);
});
test("administrators can save and disable an existing enabled probe", () => {
  const html = render(true);
  assert.match(html, /type="submit"/);
  assert.match(html, /probes\.disable</);
  assert.doesNotMatch(html, /<fieldset[^>]*disabled/);
});
