import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SourceEditor } from "../src/ui/sources/SourceEditor.js";
import type { SourcesClient } from "../src/ui/sources-client.js";
import { signalSourceSchema } from "../src/contracts/index.js";
const source = signalSourceSchema.parse({
  id: "source",
  workspaceId: "workspace",
  serviceId: "api",
  environmentId: "production",
  name: "<script>untrusted</script>",
  kind: "generic",
  grouping: "source-fingerprint",
  recovery: "explicit",
  recoveryHoldSeconds: 60,
  enabled: true,
  version: 1,
  authSecretId: null,
  createdAt: "2026-10-03T00:00:00.000Z",
  updatedAt: "2026-10-03T00:00:00.000Z",
});
test("source readers see escaped configuration without write or credential controls", () => {
  const html = renderToStaticMarkup(
    createElement(SourceEditor, {
      client: {} as SourcesClient,
      initial: source,
      services: [],
      environments: [],
      canManage: false,
      t: (key) => key,
      onSaved() {
        throw new Error("Rendering must not write");
      },
    }),
  );
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<fieldset[^>]*disabled/);
  assert.doesNotMatch(html, /type="submit"|type="password"|<script>/);
});
