import type { ModelDestination } from "../../contracts/index.js";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAI, type OpenAIProvider } from "@ai-sdk/openai";
/** Ephemeral server-side credentials. Never persisted in configuration or report metadata. */
export interface ProviderModelConfiguration {
  providerKey: Exclude<ModelDestination["provider"], "ollama">;
  apiKey: string;
  baseUrl: string;
  model: string;
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
}
export class UnsupportedModelProviderError extends Error {
  constructor(readonly provider: string) {
    super("Unsupported model provider");
    this.name = "UnsupportedModelProviderError";
  }
}
function optionalBaseUrl(baseUrl: string): string | undefined {
  return baseUrl.length === 0 ? undefined : baseUrl;
}
/** Creation only; no I/O, credentials lookup, model choice, or fallback here. */
export function createProviderLanguageModel(
  provider: ProviderModelConfiguration,
): ReturnType<OpenAIProvider> {
  switch (provider.providerKey) {
    case "gemini": {
      const google = createGoogleGenerativeAI({
        apiKey: provider.apiKey,
        fetch: provider.fetch,
        baseURL: optionalBaseUrl(provider.baseUrl),
      });
      return google(provider.model);
    }
    case "groq": {
      const groq = createGroq({
        apiKey: provider.apiKey,
        fetch: provider.fetch,
        baseURL: optionalBaseUrl(provider.baseUrl),
      });
      return groq(provider.model);
    }
    case "openai":
    case "kilocode":
    case "openrouter": {
      const openai = createOpenAI({
        apiKey: provider.apiKey,
        fetch: provider.fetch,
        baseURL: optionalBaseUrl(provider.baseUrl),
        headers: provider.headers,
      });
      return openai(provider.model);
    }
    case "anthropic": {
      const anthropic = createAnthropic({
        apiKey: provider.apiKey,
        fetch: provider.fetch,
        baseURL: optionalBaseUrl(provider.baseUrl),
      });
      return anthropic(provider.model);
    }
    default:
      throw new UnsupportedModelProviderError(String(provider.providerKey));
  }
}
