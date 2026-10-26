import type { WorkspaceId } from "../../contracts/identity.js";
import { heartbeatPingSchema } from "../../contracts/heartbeat.js";
import type { HeartbeatRepository } from "./heartbeat-ports.js";
import { HeartbeatIntake, HeartbeatIngressError } from "./heartbeat-intake.js";
function heartbeatErrorStatus(code: string): 401 | 409 | 400 {
  if (code === "invalid_token") return 401;
  if (code === "stale_ping") return 409;
  return 400;
}
export const HEARTBEAT_MAX_BYTES = 2048;
export interface HeartbeatHttpRequest {
  probeId: string;
  authorization?: string;
  contentType?: string;
  body: Uint8Array;
}
export type HeartbeatHttpResponse =
  | {
      status: 200 | 202;
      body: {
        state: "accepted" | "duplicate";
        acceptedAt: string;
        deadlineAt: string;
      };
    }
  | {
      status: 400 | 401 | 409 | 413 | 415 | 503;
      body: {
        error:
          | "invalid_input"
          | "invalid_token"
          | "stale_ping"
          | "body_too_large"
          | "unsupported_content_type"
          | "unavailable";
      };
    };
/** Machine exception to host application tRPC; hosts enforce the same byte limit while streaming. */
export class HeartbeatHttp {
  private readonly intake: HeartbeatIntake;
  constructor(
    repository: HeartbeatRepository,
    allowed: (scope: WorkspaceId) => boolean,
    private readonly available = () => true,
  ) {
    this.intake = new HeartbeatIntake(repository, allowed);
  }
  async accept(request: HeartbeatHttpRequest): Promise<HeartbeatHttpResponse> {
    if (!this.available())
      return { status: 503, body: { error: "unavailable" } };
    if (request.body.byteLength > HEARTBEAT_MAX_BYTES)
      return { status: 413, body: { error: "body_too_large" } };
    if (
      !/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?\s*$/i.test(
        request.contentType ?? "",
      )
    )
      return { status: 415, body: { error: "unsupported_content_type" } };
    const match = /^Bearer (ehb_[A-Za-z0-9_-]{43})$/i.exec(
      request.authorization ?? "",
    );
    if (!match) return { status: 401, body: { error: "invalid_token" } };
    let input;
    try {
      input = heartbeatPingSchema.parse(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(request.body),
        ),
      );
    } catch {
      return { status: 400, body: { error: "invalid_input" } };
    }
    try {
      const result = await this.intake.accept(request.probeId, match[1], input);
      return { status: result.state === "accepted" ? 202 : 200, body: result };
    } catch (error) {
      if (error instanceof HeartbeatIngressError)
        return {
          status: heartbeatErrorStatus(error.code),
          body: { error: error.code },
        };
      return { status: 503, body: { error: "unavailable" } };
    }
  }
}
