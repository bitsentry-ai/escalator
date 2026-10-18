import { lookup } from "node:dns/promises";
import {
  request as httpRequest,
  type RequestOptions,
  type IncomingMessage,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import {
  ProbeTransportError,
  type ProbeRequest,
  type ProbeTransport,
} from "../../application/probes/transport.js";
import { ProbeDestinationPolicy, ProbeDestinationError } from "./policy.js";
type Address = { address: string; family: number };
type Request = typeof httpRequest;
const headerNames = new Set([
  "accept",
  "content-type",
  "authorization",
  "x-api-key",
  "idempotency-key",
  "x-idempotency-key",
]);
/** Every redirect gets a new policy/DNS check; each connection uses only its validated peer. */
export class PolicyHttpProbeTransport implements ProbeTransport {
  constructor(
    private readonly policy: ProbeDestinationPolicy,
    private readonly resolve: (host: string) => Promise<Address[]> = (host) =>
      lookup(host, { all: true }),
    private readonly request: { http: Request; https: Request } = {
      http: httpRequest,
      https: httpsRequest,
    },
  ) {}
  async exchange(
    input: ProbeRequest,
    signal: AbortSignal,
  ): Promise<{ status: number; body: string }> {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => {
      timedOut = true;
      abort();
    }, input.timeoutMs);
    try {
      if (
        !Number.isInteger(input.timeoutMs) ||
        input.timeoutMs < 100 ||
        input.timeoutMs > 10000 ||
        !Number.isInteger(input.maxResponseBytes) ||
        input.maxResponseBytes < 1 ||
        input.maxResponseBytes > 262144 ||
        !["GET", "HEAD", "POST"].includes(input.method) ||
        Buffer.byteLength(input.body ?? "") > 65536 ||
        (input.method !== "POST" && input.body !== null)
      )
        throw new ProbeTransportError("invalid_configuration");
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(input.headers)) {
        const name = key.toLowerCase();
        if (
          !headerNames.has(name) ||
          name in headers ||
          value.length > 8192 ||
          /[^\x20-\x7e]/.test(value)
        )
          throw new ProbeTransportError("invalid_configuration");
        headers[name] = value;
      }
      headers["accept-encoding"] = "identity";
      let target = this.policy.target(input.url);
      const credentialOrigin = target.origin;
      for (let redirects = 0; redirects <= 3; redirects++) {
        controller.signal.throwIfAborted();
        const hasCredentials =
          "authorization" in headers || "x-api-key" in headers;
        if (
          hasCredentials &&
          (target.protocol !== "https:" || target.origin !== credentialOrigin)
        )
          throw new ProbeDestinationError();
        const hostname = target.hostname.replace(/^\[|\]$/g, "");
        const family = isIP(hostname);
        const addresses = family
          ? [{ address: hostname, family }]
          : await this.abortable(this.resolve(hostname), controller.signal);
        if (
          !addresses.length ||
          addresses.length > 64 ||
          addresses.some(
            (peer) =>
              isIP(peer.address) !== peer.family ||
              !this.policy.address(peer.address),
          )
        )
          throw new ProbeDestinationError();
        controller.signal.throwIfAborted();
        const peer = addresses[0];
        const options: RequestOptions & {
          rejectUnauthorized: boolean;
          autoSelectFamily: false;
        } = {
          method: input.method,
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
        const response = await this.send(
          target,
          options,
          input.body,
          input.maxResponseBytes,
        );
        if (![301, 302, 303, 307, 308].includes(response.status))
          return { status: response.status, body: response.body };
        if (!response.location || input.method === "POST" || redirects === 3)
          throw new ProbeTransportError("destination_denied");
        target = this.policy.target(new URL(response.location, target).href);
      }
      throw new ProbeTransportError("destination_denied");
    } catch (error) {
      if (signal.aborted) throw new ProbeTransportError("cancelled");
      if (timedOut) throw new ProbeTransportError("timeout");
      if (error instanceof ProbeTransportError) throw error;
      if (error instanceof ProbeDestinationError)
        throw new ProbeTransportError("destination_denied");
      // Never leak URLs, credentials, headers, DNS names or response bodies in an exception.
      throw new ProbeTransportError("network_error");
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
  private abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const abort = () => reject(new ProbeTransportError("cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      promise
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
  }
  private send(
    url: URL,
    options: RequestOptions,
    body: string | null,
    limit: number,
  ): Promise<{ status: number; body: string; location?: string }> {
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
        if (status < 100 || status > 599) {
          response.destroy();
          reject(new ProbeTransportError("network_error"));
          return;
        }
        response.on("data", (chunk: Buffer | string) => {
          const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += value.length;
          if (size > limit) {
            value.fill(0);
            clear();
            response.destroy(new ProbeTransportError("response_limit"));
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
          reject(new ProbeTransportError("network_error"));
        });
        response.on("end", () => {
          ended = true;
          const joined = Buffer.concat(chunks);
          try {
            resolve({
              status,
              body: joined.toString("utf8"),
              location: response.headers.location,
            });
          } finally {
            joined.fill(0);
            clear();
          }
        });
        response.on("close", () => {
          if (!ended) {
            clear();
            reject(new ProbeTransportError("network_error"));
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
      if (body !== null) request.write(body);
      request.end();
    });
  }
}
