import { SIGNAL_INGRESS_MAX_BYTES } from "../../contracts/index.js";
import { SignalIngressError } from "./ingest.js";
import { ProviderIntake, type ProviderDelivery } from "./provider-ingest.js";
function ingressErrorStatus(code: string): 401 | 413 | 400 {
  if (code === "invalid_token") return 401;
  if (code === "body_too_large") return 413;
  return 400;
}

export interface ProviderHttpRequest extends ProviderDelivery {
  contentType: string | undefined;
}
export type ProviderHttpResponse =
  | {
      status: 200 | 202;
      body: { state: "accepted" | "duplicate"; signalIds: string[] };
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
/** Host parsers enforce streaming bounds; this facade preserves the original bytes. */
export class ProviderHttp {
  constructor(private readonly intake: ProviderIntake) {}
  async accept(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    if (
      !/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?\s*$/i.test(
        request.contentType ?? "",
      )
    )
      return { status: 415, body: { error: "unsupported_content_type" } };
    if (request.body.byteLength > SIGNAL_INGRESS_MAX_BYTES)
      return { status: 413, body: { error: "body_too_large" } };
    try {
      const result = await this.intake.accept(request);
      return { status: result.state === "accepted" ? 202 : 200, body: result };
    } catch (error) {
      if (error instanceof SignalIngressError) {
        const status = ingressErrorStatus(error.code);
        return { status, body: { error: error.code } };
      }
      return { status: 503, body: { error: "unavailable" } };
    }
  }
}
