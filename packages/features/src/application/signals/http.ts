import type { WorkspaceId } from "../../contracts/index.js";
import { SignalIngressError, SignalIntake, parseSignalBody } from "./ingest.js";
import type { SignalRepository } from "./ports.js";
function ingressErrorStatus(code: string): 401 | 413 | 400 {
  if (code === "invalid_token") return 401;
  if (code === "body_too_large") return 413;
  return 400;
}

export interface SignalHttpRequest {
  sourceId: string;
  authorization: string | undefined;
  contentType: string | undefined;
  /** The host must enforce the byte limit while streaming before constructing this buffer. */
  body: Uint8Array;
}
export type SignalHttpResponse =
  | {
      status: 200 | 202;
      body: { state: "accepted" | "duplicate"; signalId: string };
    }
  | {
      status: 400 | 401 | 413 | 415 | 503;
      body: {
        error:
          | "invalid_input"
          | "invalid_token"
          | "body_too_large"
          | "unsupported_content_type"
          | "unavailable";
      };
    };
/** Framework-neutral machine ingress; no cookie session or request-selected tenant. */
export class SignalHttp {
  private readonly intake: SignalIntake;
  constructor(
    repository: SignalRepository,
    allowedWorkspace: (scope: WorkspaceId) => boolean,
  ) {
    this.intake = new SignalIntake({
      transaction: (scope, work) => repository.transaction(scope, work),
      async findTokenContext(hash) {
        const context = await repository.findTokenContext(hash);
        return context && allowedWorkspace(context.workspaceId)
          ? context
          : undefined;
      },
    });
  }
  async accept(request: SignalHttpRequest): Promise<SignalHttpResponse> {
    if (
      !/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?\s*$/i.test(
        request.contentType ?? "",
      )
    )
      return { status: 415, body: { error: "unsupported_content_type" } };
    const match = /^Bearer (esi_[A-Za-z0-9_-]{43})$/i.exec(
      request.authorization ?? "",
    );
    if (!match) return { status: 401, body: { error: "invalid_token" } };
    try {
      const input = parseSignalBody(request.body);
      const result = await this.intake.accept(
        request.sourceId,
        match[1],
        input,
      );
      return { status: result.state === "accepted" ? 202 : 200, body: result };
    } catch (error) {
      if (error instanceof SignalIngressError) {
        const status = ingressErrorStatus(error.code);
        return { status, body: { error: error.code } };
      }
      // Never expose database, provider, source-existence or credential details.
      return { status: 503, body: { error: "unavailable" } };
    }
  }
}
