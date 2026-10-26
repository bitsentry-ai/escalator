import { lookup } from "node:dns/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import { isPublicChannelAddress } from "../../adapters/channels/public-address.js";
import type { OperationContext } from "../ports/index.js";
import {
  repositoryComparisonSchema,
  type RepositoryComparison,
} from "./github-diff.js";
export type GithubDiffFailure =
  | "invalid_configuration"
  | "not_authorized"
  | "not_found"
  | "timeout"
  | "cancelled"
  | "invalid_response"
  | "unreachable";
export class GithubDiffError extends Error {
  constructor(readonly reason: GithubDiffFailure) {
    super("Repository comparison unavailable: " + reason);
    this.name = "GithubDiffError";
  }
}
type Address = { address: string; family: number };
/** GitHub.com only. Immutable commit selectors, one GET, no redirects, proxy,
 * retries or connection reuse. No credentials or response URLs escape in errors.
 * Hosts own connection authorization and credential resolution around this call.
 */
export class GithubDiffHttp {
  constructor(
    private readonly resolve: (host: string) => Promise<Address[]> = (host) =>
      lookup(host, { all: true }),
    private readonly request: typeof httpsRequest = httpsRequest,
  ) {}
  async read(
    comparisonInput: RepositoryComparison,
    token: string | undefined,
    context: OperationContext,
  ): Promise<string> {
    const parsed = repositoryComparisonSchema.safeParse(comparisonInput);
    if (
      !parsed.success ||
      !Number.isInteger(context.timeoutMs) ||
      context.timeoutMs < 1 ||
      context.timeoutMs > 10000 ||
      (token !== undefined &&
        (!token.length || token.length > 8192 || /[^\x21-\x7e]/.test(token)))
    )
      throw new GithubDiffError("invalid_configuration");
    const comparison = parsed.data;
    const parent = context.signal;
    const timeoutMs = context.timeoutMs;
    const url = new URL(
      `https://api.github.com/repos/${comparison.owner}/${comparison.repository}/compare/${comparison.baseSha}...${comparison.headSha}`,
    );
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    parent.addEventListener("abort", abort, { once: true });
    if (parent.aborted) abort();
    const timer = setTimeout(() => {
      timedOut = true;
      abort();
    }, timeoutMs);
    try {
      controller.signal.throwIfAborted();
      const addresses = await this.abortable(
        this.resolve("api.github.com"),
        controller.signal,
      );
      if (
        !addresses.length ||
        addresses.length > 64 ||
        addresses.some(
          (address) =>
            isIP(address.address) !== address.family ||
            !isPublicChannelAddress(address.address),
        )
      )
        throw new GithubDiffError("unreachable");
      controller.signal.throwIfAborted();
      const peer = addresses[0];
      const headers: Record<string, string> = {
        accept: "application/vnd.github+json",
        "accept-encoding": "identity",
        "x-github-api-version": "2022-11-28",
        "user-agent": "Escalator",
      };
      if (token !== undefined) headers.authorization = "Bearer " + token;
      const options: RequestOptions & { autoSelectFamily: false } = {
        method: "GET",
        headers,
        agent: false,
        signal: controller.signal,
        maxHeaderSize: 16384,
        rejectUnauthorized: true,
        family: peer.family,
        autoSelectFamily: false,
        lookup: (_hostname, _options, callback) =>
          callback(null, peer.address, peer.family),
      };
      const body = await this.abortable(
        this.exchange(url, options),
        controller.signal,
      );
      controller.signal.throwIfAborted();
      return body;
    } catch (error) {
      if (parent.aborted) throw new GithubDiffError("cancelled");
      if (timedOut) throw new GithubDiffError("timeout");
      if (error instanceof GithubDiffError) throw error;
      throw new GithubDiffError("unreachable");
    } finally {
      clearTimeout(timer);
      parent.removeEventListener("abort", abort);
    }
  }
  private abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const abort = () => reject(new GithubDiffError("cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      operation
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
  }
  private exchange(url: URL, options: RequestOptions): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = this.request(url, options, (res) => {
        let stopped = false;
        const failure = (reason: GithubDiffFailure) => {
          stopped = true;
          reject(new GithubDiffError(reason));
          res.destroy();
          req.destroy();
        };
        const status = res.statusCode;
        if (status !== 200) {
          failure(
            status === 401 || status === 403
              ? "not_authorized"
              : status === 404
                ? "not_found"
                : "invalid_response",
          );
          return;
        }
        const encoding = res.headers["content-encoding"];
        const length = res.headers["content-length"];
        if (
          (encoding !== undefined && encoding !== "identity") ||
          (length !== undefined &&
            (!/^\d+$/.test(length) || Number(length) > 1048576))
        ) {
          failure("invalid_response");
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("error", () => reject(new GithubDiffError("unreachable")));
        res.on("aborted", () => reject(new GithubDiffError("unreachable")));
        res.on("data", (chunk: Buffer) => {
          if (stopped) return;
          bytes += chunk.length;
          if (bytes > 1048576) {
            failure("invalid_response");
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (stopped) return;
          if (!res.complete) {
            reject(new GithubDiffError("invalid_response"));
            return;
          }
          try {
            resolve(
              new TextDecoder("utf-8", { fatal: true }).decode(
                Buffer.concat(chunks),
              ),
            );
          } catch {
            reject(new GithubDiffError("invalid_response"));
          }
        });
      });
      req.on("error", () => reject(new GithubDiffError("unreachable")));
      req.end();
    });
  }
}
