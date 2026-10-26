import test from "node:test";
import assert from "node:assert/strict";
import {
  createProviderLanguageModel,
  UnsupportedModelProviderError,
  type ProviderModelConfiguration,
} from "../src/investigation/models/provider-model-factory.js";

const keys = [
  "gemini",
  "groq",
  "openai",
  "kilocode",
  "openrouter",
  "anthropic",
] as const;
const prompt = [
  {
    role: "user" as const,
    content: [{ type: "text" as const, text: "hello" }],
  },
];
for (const providerKey of keys) {
  test(`${providerKey} uses the configured model, endpoint and transport without I/O at creation`, async () => {
    const calls: {
      url: string;
      headers: Headers;
      body: Record<string, unknown>;
    }[] = [];
    const model = createProviderLanguageModel({
      providerKey,
      model: "configured-model",
      apiKey: "test-secret",
      baseUrl: "https://models.example.test/v1",
      fetch: async (url, init) => {
        calls.push({
          url: String(url),
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)),
        });
        throw new Error("test transport stopped before any network access");
      },
    });
    assert.equal(model.modelId, "configured-model");
    assert.equal(calls.length, 0);
    await assert.rejects(
      Promise.resolve(model.doGenerate({ prompt, maxOutputTokens: 16 })),
    );
    assert.equal(calls.length, 1);
    assert.equal(new URL(calls[0].url).origin, "https://models.example.test");
    assert.equal(calls[0].headers.get("HTTP-Referer"), null);
    assert.equal(calls[0].headers.get("X-Title"), null);
    let authHeader = "authorization";
    if (providerKey === "gemini") authHeader = "x-goog-api-key";
    else if (providerKey === "anthropic") authHeader = "x-api-key";
    assert.equal(
      calls[0].headers.get(authHeader),
      authHeader === "authorization" ? "Bearer test-secret" : "test-secret",
    );
    if (providerKey !== "gemini")
      assert.equal(calls[0].body.model, "configured-model");
    else assert.match(calls[0].url, /models\/configured-model/);
  });
}

test("compatibility callers may explicitly supply OpenRouter attribution headers", async () => {
  let headers = new Headers();
  const model = createProviderLanguageModel({
    providerKey: "openrouter",
    model: "configured",
    apiKey: "key",
    baseUrl: "https://models.example.test/v1",
    headers: {
      "HTTP-Referer": "https://host.example.test",
      "X-Title": "Host application",
    },
    fetch: async (_url, init) => {
      headers = new Headers(init?.headers);
      throw new Error("test transport");
    },
  });
  await assert.rejects(Promise.resolve(model.doGenerate({ prompt })));
  assert.equal(headers.get("HTTP-Referer"), "https://host.example.test");
  assert.equal(headers.get("X-Title"), "Host application");
});

test("Anthropic generation parses a provider response with the patched SDK utility", async () => {
  const model = createProviderLanguageModel({
    providerKey: "anthropic",
    model: "configured",
    apiKey: "key",
    baseUrl: "https://models.example.test",
    fetch: async () =>
      Response.json({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "configured",
        content: [{ type: "text", text: "diagnosis" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 4, output_tokens: 2 },
      }),
  });
  const result = await model.doGenerate({ prompt, maxOutputTokens: 16 });
  assert.deepEqual(result.content, [{ type: "text", text: "diagnosis" }]);
  assert.equal(result.usage.outputTokens.total, 2);
});

test("unknown providers and Ollama never silently select a hosted SDK", () => {
  for (const providerKey of ["unknown", "ollama"]) {
    assert.throws(
      () =>
        createProviderLanguageModel({
          providerKey,
          model: "test",
          apiKey: "test",
          baseUrl: "",
        } as ProviderModelConfiguration),
      UnsupportedModelProviderError,
    );
  }
});

const responses = {
  gemini: {
    candidates: [
      {
        content: { role: "model", parts: [{ text: "diagnosis" }] },
        finishReason: "STOP",
      },
    ],
    usageMetadata: {
      promptTokenCount: 4,
      candidatesTokenCount: 2,
      totalTokenCount: 6,
    },
  },
  groq: {
    choices: [
      { index: 0, message: { content: "diagnosis" }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
  },
  openai: {
    id: "response_test",
    model: "configured",
    output: [
      {
        type: "message",
        role: "assistant",
        id: "msg_test",
        content: [{ type: "output_text", text: "diagnosis", annotations: [] }],
      },
    ],
    usage: { input_tokens: 4, output_tokens: 2 },
  },
};
for (const providerKey of [
  "gemini",
  "groq",
  "openai",
  "kilocode",
  "openrouter",
] as const) {
  test(`${providerKey} parses generation through the patched SDK dependency tree`, async () => {
    const response =
      responses[
        providerKey === "kilocode" || providerKey === "openrouter"
          ? "openai"
          : providerKey
      ];
    const model = createProviderLanguageModel({
      providerKey,
      model: "configured",
      apiKey: "key",
      baseUrl: "https://models.example.test",
      fetch: async () => Response.json(response),
    });
    const result = await model.doGenerate({ prompt, maxOutputTokens: 16 });
    assert.equal(
      result.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join(""),
      "diagnosis",
    );
    assert.equal(result.usage.outputTokens.total, 2);
  });
}
