import { ZodError } from "zod";
import {
  deploymentIdempotencyKeySchema,
  opaqueIdSchema,
  type DeploymentReceipt,
  type DeploymentPreflightResult,
} from "../../contracts/index.js";
import { DeploymentAccessError, deploymentTokenDigest } from "./access.js";
import { DeploymentCommands, DeploymentCommandError } from "./commands.js";
import {
  DeploymentStartCoverageError,
  type DeploymentPreflight,
} from "./preflight.js";
import { DeploymentPreflightError } from "../../domain/deploy/coverage-decision.js";
export const DEPLOYMENT_MAX_BYTES = 8192;
export interface DeploymentHttpRequest {
  authorization?: string;
  contentType?: string;
  idempotencyKey?: string;
  body: Uint8Array;
}
type ErrorCode =
  | "invalid_input"
  | "invalid_token"
  | "idempotency_conflict"
  | "conflict"
  | "body_too_large"
  | "unsupported_content_type"
  | "busy"
  | "unavailable"
  | "coverage_blocked";
export interface DeploymentHttpResponse {
  status: 200 | 202 | 400 | 401 | 409 | 413 | 415 | 429 | 503;
  body:
    | DeploymentReceipt["result"]
    | DeploymentPreflightResult
    | { error: ErrorCode };
}
/** Bounded machine ingress; hosts apply the same byte limit while reading the stream. */
export class DeploymentHttp {
  private active = 0;
  constructor(
    private readonly commands: Pick<DeploymentCommands, "start" | "finish"> &
      Partial<Pick<DeploymentPreflight, "preflight">>,
    private readonly available = () => true,
    private readonly maxInFlight = 8,
  ) {
    if (!Number.isInteger(maxInFlight) || maxInFlight < 1 || maxInFlight > 64)
      throw new RangeError("Invalid deployment ingress capacity");
  }
  preflight(request: DeploymentHttpRequest) {
    return this.execute("preflight", null, request);
  }
  start(request: DeploymentHttpRequest) {
    return this.execute("start", null, request);
  }
  finish(id: string, request: DeploymentHttpRequest) {
    return this.execute("finish", id, request);
  }
  private async execute(
    action: "start" | "finish" | "preflight",
    id: string | null,
    request: DeploymentHttpRequest,
  ): Promise<DeploymentHttpResponse> {
    try {
      if (!this.available())
        return { status: 503, body: { error: "unavailable" } };
    } catch {
      return { status: 503, body: { error: "unavailable" } };
    }
    if (request.body.byteLength > DEPLOYMENT_MAX_BYTES)
      return { status: 413, body: { error: "body_too_large" } };
    if (
      !/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?\s*$/i.test(
        request.contentType ?? "",
      )
    )
      return { status: 415, body: { error: "unsupported_content_type" } };
    const match = /^Bearer (.+)$/i.exec(request.authorization ?? "");
    if (!match || !deploymentTokenDigest(match[1]))
      return { status: 401, body: { error: "invalid_token" } };
    const key = deploymentIdempotencyKeySchema.safeParse(
      request.idempotencyKey,
    );
    if (
      !key.success ||
      (action === "finish" && !opaqueIdSchema.safeParse(id).success)
    )
      return { status: 400, body: { error: "invalid_input" } };
    let body: unknown;
    try {
      body = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(request.body),
      );
    } catch {
      return { status: 400, body: { error: "invalid_input" } };
    }
    if (this.active >= this.maxInFlight)
      return { status: 429, body: { error: "busy" } };
    this.active++;
    try {
      if (action === "preflight") {
        if (!this.commands.preflight)
          return { status: 503, body: { error: "unavailable" } };
        return {
          status: 200,
          body: await this.commands.preflight(match[1], key.data, body),
        };
      }
      const result =
        action === "start"
          ? await this.commands.start(match[1], key.data, body)
          : await this.commands.finish(match[1], id!, key.data, body);
      return {
        status:
          result.state === "rejected"
            ? 409
            : result.state === "accepted"
              ? 202
              : 200,
        body: result,
      };
    } catch (error) {
      if (error instanceof DeploymentAccessError)
        return { status: 401, body: { error: "invalid_token" } };
      if (
        error instanceof ZodError ||
        (error instanceof DeploymentPreflightError &&
          error.code === "scope_violation")
      )
        return { status: 400, body: { error: "invalid_input" } };
      if (error instanceof DeploymentStartCoverageError)
        return { status: 409, body: { error: "coverage_blocked" } };
      if (error instanceof DeploymentCommandError)
        return { status: 409, body: { error: error.code } };
      return { status: 503, body: { error: "unavailable" } };
    } finally {
      // No queued work and no early slot release: the actual database operation has settled.
      this.active--;
    }
  }
}
