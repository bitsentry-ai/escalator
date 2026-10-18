import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DetectionBindingEditor } from "../src/ui/detection/DetectionBindingEditor.js";
import type { DetectionClient } from "../src/ui/detection-client.js";
import {
  serviceIdSchema,
  environmentIdSchema,
} from "../src/contracts/index.js";
test("automatic paging renders as a disabled explicit selection before trusted configuration loads", () => {
  const html = renderToStaticMarkup(
    createElement(DetectionBindingEditor, {
      client: {} as DetectionClient,
      serviceId: serviceIdSchema.parse("service"),
      environmentId: environmentIdSchema.parse("production"),
      canManage: false,
      t: (key) => key,
    }),
  );
  assert.match(html, /detection.help/);
  assert.match(html, /<fieldset[^>]*disabled/);
  assert.match(html, /detection.none/);
  assert.doesNotMatch(html, /type="submit"|checked=""/);
});
