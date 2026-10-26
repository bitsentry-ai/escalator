import { ZodError, type z } from "zod";
import {
  deploymentIdempotencyKeySchema,
  opaqueIdSchema,
  type DeploymentReceipt,
  type DeploymentPreflightResult,
} from "../../contracts/index.js";
import { expectDefined } from "../../contracts/expect-defined.js";
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
function statusFor(state: string): 200 | 202 | 409 {
  if (state === "rejected") return 409;
  if (state === "accepted") return 202;
  return 200;
}
type ParsedRequest =
  | { rejected: DeploymentHttpResponse }
  | {
      token: string;
      key: z.infer<typeof deploymentIdempotencyKeySchema>;
      body: unknown;
    };
/** Checks size, media type, bearer token, idempotency key, deployment id and JSON body, in that order. */
function parseDeploymentRequest(
  action: "start" | "finish" | "preflight",
  id: string | null,
  request: DeploymentHttpRequest,
): ParsedRequest {
  if (request.body.byteLength > DEPLOYMENT_MAX_BYTES)
    return { rejected: { status: 413, body: { error: "body_too_large" } } };
  if (
    !/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?\s*$/i.test(
      request.contentType ?? "",
    )
  )
    return {
      rejected: { status: 415, body: { error: "unsupported_content_type" } },
    };
  const match = /^Bearer (.+)$/i.exec(request.authorization ?? "");
  if (!match || !deploymentTokenDigest(match[1]))
    return { rejected: { status: 401, body: { error: "invalid_token" } } };
  const key = deploymentIdempotencyKeySchema.safeParse(request.idempotencyKey);
  if (
    !key.success ||
    (action === "finish" && !opaqueIdSchema.safeParse(id).success)
  )
    return { rejected: { status: 400, body: { error: "invalid_input" } } };
  try {
    const body: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(request.body),
    );
    return { token: match[1], key: key.data, body };
  } catch {
    return { rejected: { status: 400, body: { error: "invalid_input" } } };
  }
}
function failureResponse(error: unknown): DeploymentHttpResponse {
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
}
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
  private isAvailable(): boolean {
    try {
      return this.available();
    } catch {
      return false;
    }
  }
  private async execute(
    action: "start" | "finish" | "preflight",
    id: string | null,
    request: DeploymentHttpRequest,
  ): Promise<DeploymentHttpResponse> {
    if (!this.isAvailable())
      return { status: 503, body: { error: "unavailable" } };
    const parsed = parseDeploymentRequest(action, id, request);
    if ("rejected" in parsed) return parsed.rejected;
    const { token, key, body } = parsed;
    if (this.active >= this.maxInFlight)
      return { status: 429, body: { error: "busy" } };
    this.active++;
    try {
      if (action === "preflight") {
        if (!this.commands.preflight)
          return { status: 503, body: { error: "unavailable" } };
        return {
          status: 200,
          body: await this.commands.preflight(token, key, body),
        };
      }
      const result =
        action === "start"
          ? await this.commands.start(token, key, body)
          : await this.commands.finish(
              token,
              // Validated as an opaque id above.
              expectDefined(id, "deployment id"),
              key,
              body,
            );
      return { status: statusFor(result.state), body: result };
    } catch (error) {
      return failureResponse(error);
    } finally {
      // No queued work and no early slot release: the actual database operation has settled.
      this.active--;
    }
  }
}
