import { lookup } from "node:dns/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import type { ChannelHttpTransport } from "./ports.js";
import { isPublicChannelAddress } from "./public-address.js";

type Address = { address: string; family: number };
type Resolve = (hostname: string) => Promise<Address[]>;
type Request = Parameters<ChannelHttpTransport["send"]>[0];
const failure = () => new Error("Channel HTTP request failed");
const allowedHeaders = new Set([
  "content-type",
  "authorization",
  "idempotency-key",
]);

/** No proxy, redirect, connection reuse, or second DNS lookup can change the peer. */
export class PublicHttpsChannelTransport implements ChannelHttpTransport {
  constructor(
    private readonly resolve: Resolve = (hostname) =>
      lookup(hostname, { all: true }),
    private readonly request: typeof httpsRequest = httpsRequest,
  ) {}
  async send(input: Request): Promise<{ status: number; body: string }> {
    const { body, method, signal } = input;
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, 10_000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      if (method !== "GET" && method !== "POST") throw failure();
      signal.throwIfAborted();
      const url = new URL(input.url);
      if (
        input.url.length > 4096 ||
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.hash ||
        (url.port && url.port !== "443")
      )
        throw failure();
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(input.headers)) {
        const normalized = name.toLowerCase();
        if (
          !allowedHeaders.has(normalized) ||
          normalized in headers ||
          value.length > 8192 ||
          /[^\x20-\x7e]/.test(value)
        )
          throw failure();
        headers[normalized] = value;
      }
      if (Buffer.byteLength(body ?? "") > 16_384) throw failure();
      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      const addresses = isIP(hostname)
        ? [{ address: hostname, family: isIP(hostname) }]
        : await this.withAbort(this.resolve(hostname), controller.signal);
      if (
        !addresses.length ||
        addresses.length > 64 ||
        addresses.some(
          (a) =>
            isIP(a.address) !== a.family || !isPublicChannelAddress(a.address),
        )
      )
        throw failure();
      controller.signal.throwIfAborted();
      const peer = addresses[0]!;
      const options: RequestOptions & { autoSelectFamily: false } = {
        method,
        headers,
        agent: false,
        signal: controller.signal,
        maxHeaderSize: 16_384,
        rejectUnauthorized: true,
        family: peer.family,
        autoSelectFamily: false,
        lookup: (_hostname, _options, callback) =>
          callback(null, peer.address, peer.family),
      };
      return await this.exchange(url, options, body);
    } catch {
      // Never propagate Node errors containing a URL, secret, header or DNS name.
      throw failure();
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
  private withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const abort = () => reject(failure());
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      operation
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
  }
  private exchange(
    url: URL,
    options: RequestOptions,
    body?: string,
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = this.request(url, options, (res) => {
        const chunks: Buffer[] = [];
        let length = 0;
        res.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > 65_536) {
            res.destroy();
            req.destroy(failure());
            reject(failure());
          } else chunks.push(chunk);
        });
        res.on("error", () => reject(failure()));
        res.on("aborted", () => reject(failure()));
        res.on("end", () => {
          if (!res.complete) return reject(failure());
          // Return redirects as an ambiguous result; never follow Location.
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      });
      req.on("error", () => reject(failure()));
      req.end(body);
    });
  }
}
