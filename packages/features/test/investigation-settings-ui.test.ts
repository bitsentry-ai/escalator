import assert from "node:assert/strict";
import { test } from "node:test";
import { investigationSettingsSchema } from "../src/contracts/index.js";
import {
  investigationForm,
  investigationInput,
} from "../src/ui/investigation/form.js";
const scope = { serviceId: "service", environmentId: "production" };
const initial = investigationSettingsSchema.parse({
  profile: {
    id: "profile",
    revision: 7,
    scope: { workspaceId: "org_one", ...scope },
    destination: {
      provider: "ollama",
      model: "local-model",
      location: "local",
      origin: "http://127.0.0.1:11434",
    },
    endpoint: "http://127.0.0.1:11434",
    secretId: null,
  },
  enabled: true,
  limits: {
    maxDurationMs: 30000,
    maxModelCalls: 2,
    maxEvidenceReads: 3,
    maxEvidenceBytes: 10240,
    maxOutputTokens: 2048,
    maxTraceEvents: 44,
  },
  sources: [
    {
      kind: "log",
      sourceId: "retained_connection",
      lookbackMs: 60000,
      limit: 10,
    },
  ],
  createdAt: "2026-10-05T00:00:00.000Z",
  updatedAt: "2026-10-05T00:00:00.000Z",
});
test("new configuration stays disabled and tenant identity never enters a settings request", () => {
  const form = investigationForm();
  form.model = "local-model";
  const request = investigationInput(form, scope);
  assert.equal(request.kind, "create");
  assert.equal(request.input.enabled, false);
  assert.equal(request.input.destination.location, "local");
  assert.equal(JSON.stringify(request).includes("workspaceId"), false);
  assert.equal(JSON.stringify(request).includes("validation"), false);
});
test("edits retain revision, budgets and unavailable selections without mutating loaded settings", () => {
  const form = investigationForm(initial);
  form.enabled = false;
  const request = investigationInput(form, scope, initial);
  assert.equal(request.kind, "update");
  if (request.kind !== "update") return;
  assert.equal(request.input.expectedRevision, 7);
  assert.equal(request.input.id, "profile");
  assert.deepEqual(request.input.limits, initial.limits);
  assert.deepEqual(request.input.sources, initial.sources);
  form.sources[0].limit = 20;
  assert.equal(initial.sources[0].limit, 10);
  assert.equal(initial.enabled, true);
});
test("profile validation rejects embedded credentials, URL query data and hosted models without a secret", () => {
  for (const endpoint of [
    "http://user:password@127.0.0.1:11434",
    "http://127.0.0.1:11434?token=private",
    "http://127.0.0.1:11434#fragment",
  ]) {
    const form = investigationForm(initial);
    form.endpoint = endpoint;
    assert.throws(() => investigationInput(form, scope, initial));
  }
  const form = investigationForm(initial);
  form.provider = "openai";
  form.location = "remote";
  form.endpoint = "https://api.openai.com/v1";
  assert.throws(() => investigationInput(form, scope, initial));
  form.secretId = "opaque_model_key";
  const request = investigationInput(form, scope, initial);
  assert.equal(request.input.destination.origin, "https://api.openai.com");
  assert.equal(request.input.secretId, "opaque_model_key");
});
test("invalid budgets and duplicate evidence selections fail before transport", () => {
  const form = investigationForm(initial);
  form.durationSeconds = "0";
  assert.throws(() => investigationInput(form, scope, initial));
  form.durationSeconds = "30";
  form.sources.push({ ...form.sources[0] });
  assert.throws(() => investigationInput(form, scope, initial));
});
