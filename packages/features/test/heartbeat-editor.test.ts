import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HeartbeatEditor } from "../src/ui/heartbeats/HeartbeatEditor.js";
import { HeartbeatStatus } from "../src/ui/heartbeats/HeartbeatStatus.js";
import type { HeartbeatsClient } from "../src/ui/heartbeats-client.js";
test("heartbeat readers cannot submit configuration or issue grants", () => {
  const html = renderToStaticMarkup(
    createElement(HeartbeatEditor, {
      client: {} as HeartbeatsClient,
      services: [],
      environments: [],
      canManage: false,
      t: (key) => key,
      onSaved() {
        throw new Error("Rendering cannot write");
      },
    }),
  );
  assert.match(html, /<fieldset[^>]*disabled/);
  assert.doesNotMatch(html, /type="submit"|sources.issue/);
});
test("heartbeat status distinguishes loading from stored state and makes no health claim", () => {
  const html = renderToStaticMarkup(
    createElement(HeartbeatStatus, {
      client: {} as HeartbeatsClient,
      id: "heartbeat",
      version: 1,
      t: (key) => key,
    }),
  );
  assert.match(html, /role="status"/);
  assert.match(html, /monitoring.snapshotHelp/);
  assert.match(html, /heartbeats.statusHelp/);
  assert.doesNotMatch(html, /<dl>|heartbeats.none/);
});
