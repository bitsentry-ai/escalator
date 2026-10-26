import { lookup } from "node:dns/promises";
import {
  request as httpRequest,
  type RequestOptions,
  type IncomingMessage,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { OperationContext } from "../ports/index.js";
import {
  ModelDestinationPolicy,
  ModelDestinationError,
  type ModelLocation,
} from "./destination-policy.js";
export type ModelTransportFailure =
  | "invalid_configuration"
  | "destination_denied"
  | "cancelled"
  | "timeout"
  | "response_limit"
  | "network_error";
export class ModelTransportError extends Error {
  constructor(readonly reason: ModelTransportFailure) {
    super("Model transport failed: " + reason);
    this.name = "ModelTransportError";
  }
}
type Address = { address: string; family: number };
type Request = typeof httpRequest;
const allowedHeaders = new Set([
  "accept",
  "content-type",
  "authorization",
  "x-api-key",
  "x-goog-api-key",
  "anthropic-version",
  "anthropic-beta",
  "user-agent",
  "http-referer",
  "x-title",
  "openai-organization",
  "openai-project",
]);
export interface ModelHttpLimits {
  requestBytes: number;
  responseBytes: number;
}
/** One approved endpoint, no redirects/proxy, bounded non-streaming JSON, pinned DNS. */
/** Only a JSON POST with a string body within the request limit; returns that body. */
function assertModelRequest(
  input: Parameters<typeof globalThis.fetch>[0],
  init: RequestInit | undefined,
  maxRequest: number,
): string {
  if (
    !(typeof input === "string" || input instanceof URL) ||
    init?.method !== "POST" ||
    typeof init.body !== "string" ||
    Buffer.byteLength(init.body) > maxRequest
  )
    throw new ModelTransportError("invalid_configuration");
  return init.body;
}
/** Allowed, printable, bounded JSON request headers, with compression disabled. */
function modelHeaders(init: HeadersInit | undefined): Record<string, string> {
  let inputHeaders: Headers;
  try {
    inputHeaders = new Headers(init);
  } catch {
    throw new ModelTransportError("invalid_configuration");
  }
  const headers: Record<string, string> = {};
  let headerBytes = 0;
  for (const [key, value] of inputHeaders) {
    headerBytes += key.length + value.length;
    if (
      !allowedHeaders.has(key) ||
      /[^\x20-\x7e]/.test(value) ||
      value.length > 8192 ||
      headerBytes > 16384
    )
      throw new ModelTransportError("invalid_configuration");
    headers[key] = value;
  }
  if (!/^application\/json(?:\s*;|$)/i.test(headers["content-type"] ?? ""))
    throw new ModelTransportError("invalid_configuration");
  headers["accept-encoding"] = "identity";
  return headers;
}
function modelTransportError(
  error: unknown,
  cancelled: boolean,
  timedOut: boolean,
): ModelTransportError {
  if (cancelled) return new ModelTransportError("cancelled");
  if (timedOut) return new ModelTransportError("timeout");
  if (error instanceof ModelTransportError) return error;
  if (error instanceof ModelDestinationError)
    return new ModelTransportError("destination_denied");
  return new ModelTransportError("network_error");
}
export class BoundedModelHttp {
  constructor(
    private readonly policy: ModelDestinationPolicy,
    private readonly resolve: (host: string) => Promise<Address[]> = (host) =>
      lookup(host, { all: true }),
    private readonly request: { http: Request; https: Request } = {
      http: httpRequest,
      https: httpsRequest,
    },
  ) {}
  bind(
    endpoint: string,
    location: ModelLocation,
    context: OperationContext,
    limits: ModelHttpLimits,
  ): typeof globalThis.fetch {
    const base = this.policy.endpoint(endpoint, location);
    if (
      !Number.isInteger(context.timeoutMs) ||
      context.timeoutMs < 1 ||
      context.timeoutMs > 120000 ||
      [limits.requestBytes, limits.responseBytes].some(
        (limit) => !Number.isInteger(limit) || limit < 1 || limit > 1048576,
      )
    )
      throw new ModelTransportError("invalid_configuration");
    // Copy primitives: mutating a profile/options object cannot expand an in-flight allowance.
    const timeout = context.timeoutMs;
    const parent = context.signal;
    const maxRequest = limits.requestBytes;
    const maxResponse = limits.responseBytes;
    return async (input, init) => {
      const controller = new AbortController();
      let timedOut = false;
      const abort = () => controller.abort();
      const signals = [parent, init?.signal].filter(
        (signal): signal is AbortSignal => Boolean(signal),
      );
      for (const signal of signals) {
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }
      const timer = setTimeout(() => {
        timedOut = true;
        abort();
      }, timeout);
      try {
        controller.signal.throwIfAborted();
        const body = assertModelRequest(input, init, maxRequest);
        const target = this.policy.request(String(input), base, location);
        const headers = modelHeaders(init?.headers);
        const peer = await this.resolvePeer(
          target,
          location,
          controller.signal,
        );
        controller.signal.throwIfAborted();
        const options: RequestOptions & {
          rejectUnauthorized: boolean;
          autoSelectFamily: false;
        } = {
          method: "POST",
          headers,
          agent: false,
          signal: controller.signal,
          maxHeaderSize: 16384,
          rejectUnauthorized: true,
          family: peer.family,
          autoSelectFamily: false,
          lookup: (_host, _options, callback) =>
            callback(null, peer.address, peer.family),
        };
        const result = await this.abortable(
          this.send(target, options, body, maxResponse),
          controller.signal,
        );
        controller.signal.throwIfAborted();
        return result;
      } catch (error) {
        throw modelTransportError(
          error,
          signals.some((signal) => signal.aborted),
          timedOut,
        );
      } finally {
        clearTimeout(timer);
        for (const signal of signals)
          signal.removeEventListener("abort", abort);
      }
    };
  }
  /** Resolves the endpoint host and admits it only when every address passes the location's policy. */
  private async resolvePeer(
    target: URL,
    location: ModelLocation,
    signal: AbortSignal,
  ): Promise<Address> {
    const hostname = target.hostname.replace(/^\[|\]$/g, "");
    const family = isIP(hostname);
    const peers = family
      ? [{ address: hostname, family }]
      : await this.abortable(this.resolve(hostname), signal);
    if (
      !peers.length ||
      peers.length > 64 ||
      peers.some(
        (peer) =>
          isIP(peer.address) !== peer.family ||
          !this.policy.address(peer.address, location),
      )
    )
      throw new ModelDestinationError();
    return peers[0];
  }
  private abortable<T>(
    promise: PromiseLike<T>,
    signal: AbortSignal,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const abort = () => reject(new ModelTransportError("cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      Promise.resolve(promise)
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
  }
  private send(
    url: URL,
    options: RequestOptions,
    body: string,
    limit: number,
  ): Promise<Response> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let ended = false;
      const clear = () => {
        for (const chunk of chunks) chunk.fill(0);
        chunks.length = 0;
      };
      const consume = (response: IncomingMessage) => {
        const status = response.statusCode ?? 0;
        const encoding = response.headers["content-encoding"];
        if (
          status < 200 ||
          status > 599 ||
          (status >= 300 && status < 400) ||
          (encoding && encoding !== "identity")
        ) {
          response.destroy();
          reject(
            new ModelTransportError(
              status >= 300 && status < 400
                ? "destination_denied"
                : "network_error",
            ),
          );
          return;
        }
        const declared = response.headers["content-length"];
        if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
          response.destroy();
          reject(new ModelTransportError("response_limit"));
          return;
        }
        response.on("data", (chunk: Buffer | string) => {
          const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += value.length;
          if (size > limit) {
            value.fill(0);
            clear();
            response.destroy(new ModelTransportError("response_limit"));
            return;
          }
          chunks.push(value);
        });
        response.on("error", (error) => {
          clear();
          reject(error);
        });
        response.on("aborted", () => {
          clear();
          reject(new ModelTransportError("network_error"));
        });
        response.on("end", () => {
          ended = true;
          const joined = Buffer.concat(chunks);
          try {
            resolve(
              new Response(joined.length ? new Uint8Array(joined) : null, {
                status,
                headers: {
                  "content-type":
                    response.headers["content-type"] ?? "application/json",
                },
              }),
            );
          } catch {
            reject(new ModelTransportError("network_error"));
          } finally {
            joined.fill(0);
            clear();
          }
        });
        response.on("close", () => {
          if (!ended) {
            clear();
            reject(new ModelTransportError("network_error"));
          }
        });
      };
      const request = (
        url.protocol === "https:" ? this.request.https : this.request.http
      )(url, options, consume);
      request.on("error", (error) => {
        clear();
        reject(error);
      });
      request.end(body);
    });
  }
}
