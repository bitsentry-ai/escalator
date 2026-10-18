import { generateText } from "ai";
import { z } from "zod";
import type {
  SecretStore,
  SecretUse,
} from "../../application/ports/secrets.js";
import { opaqueIdSchema } from "../../contracts/index.js";
import type {
  ModelResolver,
  ModelScope,
  OperationContext,
  ResolvedModel,
  ModelGenerationRequest,
  ModelGenerationResponse,
} from "../ports/index.js";
import { createProviderLanguageModel } from "./provider-model-factory.js";
import {
  modelProfileSchema,
  type ModelProfile,
  type ModelProfileReader,
} from "./profiles.js";
import { ModelTransportError, type BoundedModelHttp } from "./http.js";
export type ModelFailure =
  | "profile_unavailable"
  | "profile_changed"
  | "invalid_request"
  | "invalid_response"
  | "cancelled"
  | "timeout"
  | "model_unavailable";
export class ModelExecutionError extends Error {
  constructor(readonly reason: ModelFailure) {
    super("Model operation failed: " + reason);
    this.name = "ModelExecutionError";
  }
}
const inputSchema = z.strictObject({
  instruction: z.string().min(1).max(16384),
  input: z.string().max(262144),
  maxOutputTokens: z.number().int().min(1).max(16384),
});
const ollamaResponse = z.object({
  error: z.never().optional(),
  response: z.string().max(1048576),
  done: z.literal(true),
  done_reason: z.enum(["stop", "length"]).optional(),
  eval_count: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
});
/** No fallback, automatic tools or SDK retries; per-call secrets stay inside the callback. */
export class ScopedModelResolver implements ModelResolver {
  private readonly authorization: Pick<
    SecretUse,
    "queue" | "workId" | "claimToken"
  >;
  constructor(
    private readonly profiles: ModelProfileReader,
    private readonly secrets: SecretStore,
    private readonly transport: Pick<BoundedModelHttp, "bind">,
    authorization: Pick<SecretUse, "queue" | "workId" | "claimToken">,
  ) {
    this.authorization = Object.freeze({ ...authorization });
  }
  async resolve(
    scope: ModelScope,
    profileId: string,
    context: OperationContext,
  ): Promise<ResolvedModel> {
    const requestedScope = { ...scope };
    const captured = await this.bounded(context, async (operation) =>
      this.load(requestedScope, profileId, operation),
    );
    const destination = Object.freeze({ ...captured.destination });
    return {
      destination,
      generate: (request, operation) =>
        this.bounded(operation, async (active) => {
          const parsed = inputSchema.safeParse(request);
          if (
            !parsed.success ||
            Buffer.byteLength(parsed.data.instruction) > 16384 ||
            Buffer.byteLength(parsed.data.input) > 262144
          )
            throw new ModelExecutionError("invalid_request");
          const current = await this.load(captured.scope, captured.id, active);
          if (JSON.stringify(current) !== JSON.stringify(captured))
            throw new ModelExecutionError("profile_changed");
          active.signal.throwIfAborted();
          const fetch = this.transport.bind(
            captured.endpoint,
            captured.destination.location,
            active,
            { requestBytes: 1048576, responseBytes: 1048576 },
          );
          if (captured.secretId === null)
            return this.generate(captured, parsed.data, active, null, fetch);
          return this.secrets.withSecret(
            {
              ...this.authorization,
              workspaceId: captured.scope.workspaceId,
              secretId: captured.secretId,
              signal: active.signal,
            },
            async (bytes) => {
              active.signal.throwIfAborted();
              if (bytes.byteLength < 1 || bytes.byteLength > 8192)
                throw new ModelExecutionError("model_unavailable");
              const key = new TextDecoder("utf-8", { fatal: true }).decode(
                bytes,
              );
              if (/[^\x21-\x7e]/.test(key))
                throw new ModelExecutionError("model_unavailable");
              return this.generate(captured, parsed.data, active, key, fetch);
            },
          );
        }),
    };
  }
  private async load(
    scope: ModelScope,
    id: string,
    context: OperationContext,
  ): Promise<ModelProfile> {
    if (!opaqueIdSchema.safeParse(id).success)
      throw new ModelExecutionError("profile_unavailable");
    context.signal.throwIfAborted();
    const raw = await this.profiles.load({ ...scope }, id, context);
    context.signal.throwIfAborted();
    const profile = modelProfileSchema.safeParse(raw);
    if (
      !profile.success ||
      profile.data.id !== id ||
      profile.data.scope.workspaceId !== scope.workspaceId ||
      profile.data.scope.serviceId !== scope.serviceId ||
      profile.data.scope.environmentId !== scope.environmentId
    )
      throw new ModelExecutionError("profile_unavailable");
    return profile.data;
  }
  private async generate(
    profile: ModelProfile,
    request: ModelGenerationRequest,
    context: OperationContext,
    key: string | null,
    fetch: typeof globalThis.fetch,
  ): Promise<ModelGenerationResponse> {
    context.signal.throwIfAborted();
    if (profile.destination.provider === "ollama") {
      const response = await fetch(
        profile.endpoint.replace(/\/$/, "") + "/api/generate",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(key === null ? {} : { authorization: "Bearer " + key }),
          },
          signal: context.signal,
          body: JSON.stringify({
            model: profile.destination.model,
            system: request.instruction,
            prompt: request.input,
            stream: false,
            options: { num_predict: request.maxOutputTokens },
          }),
        },
      );
      if (!response.ok) throw new ModelExecutionError("model_unavailable");
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new ModelExecutionError("invalid_response");
      }
      const result = ollamaResponse.safeParse(payload);
      if (!result.success || !result.data.response.trim())
        throw new ModelExecutionError("invalid_response");
      return {
        text: result.data.response,
        completion: result.data.done_reason ?? "unknown",
        usage: { outputTokens: result.data.eval_count ?? null },
      };
    }
    const model = createProviderLanguageModel({
      providerKey: profile.destination.provider,
      model: profile.destination.model,
      baseUrl: profile.endpoint,
      apiKey: key ?? "",
      fetch,
    });
    const result = await generateText({
      model,
      system: request.instruction,
      prompt: request.input,
      maxOutputTokens: request.maxOutputTokens,
      maxRetries: 0,
      abortSignal: context.signal,
      toolChoice: "none",
      experimental_telemetry: {
        isEnabled: false,
        recordInputs: false,
        recordOutputs: false,
      },
    });
    if (!result.text.trim() || Buffer.byteLength(result.text) > 1048576)
      throw new ModelExecutionError("invalid_response");
    if (!["stop", "length", "unknown"].includes(result.finishReason))
      throw new ModelExecutionError("invalid_response");
    const completion =
      result.finishReason === "stop"
        ? "stop"
        : result.finishReason === "length"
          ? "length"
          : "unknown";
    const count = result.usage.outputTokens;
    if (count !== undefined && (!Number.isSafeInteger(count) || count < 0))
      throw new ModelExecutionError("invalid_response");
    return {
      text: result.text,
      completion,
      usage: { outputTokens: count ?? null },
    };
  }
  private async bounded<T>(
    context: OperationContext,
    operation: (context: OperationContext) => Promise<T>,
  ): Promise<T> {
    if (!Number.isFinite(context.timeoutMs) || context.timeoutMs < 1)
      throw new ModelExecutionError("invalid_request");
    const controller = new AbortController();
    let timeout = false;
    const abort = () => controller.abort();
    context.signal.addEventListener("abort", abort, { once: true });
    if (context.signal.aborted) abort();
    const timeoutMs = Math.min(120000, Math.floor(context.timeoutMs));
    const timer = setTimeout(() => {
      timeout = true;
      abort();
    }, timeoutMs);
    let rejectAbort: () => void = () => {};
    try {
      controller.signal.throwIfAborted();
      const cancelled = new Promise<never>((_resolve, reject) => {
        rejectAbort = () => reject(new ModelExecutionError("cancelled"));
        controller.signal.addEventListener("abort", rejectAbort, {
          once: true,
        });
      });
      const result = await Promise.race([
        operation({ signal: controller.signal, timeoutMs }),
        cancelled,
      ]);
      controller.signal.throwIfAborted();
      return result;
    } catch (error) {
      if (context.signal.aborted) throw new ModelExecutionError("cancelled");
      if (
        timeout ||
        (error instanceof ModelTransportError && error.reason === "timeout")
      )
        throw new ModelExecutionError("timeout");
      if (error instanceof ModelExecutionError) throw error;
      throw new ModelExecutionError("model_unavailable");
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", rejectAbort);
      context.signal.removeEventListener("abort", abort);
    }
  }
}
