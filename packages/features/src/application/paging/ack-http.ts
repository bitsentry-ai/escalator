import {
  workspaceIdSchema,
  type AcknowledgementResult,
  type WorkspaceId,
} from "../../contracts/index.js";
import type { PageAcknowledgements } from "./acknowledge.js";
export const acknowledgementHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
} as const;
export const acknowledgementHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Escalator</title></head><body><div id="root"></div><script src="./assets/client.js" defer></script></body></html>`;
/** Capability authentication only; host-owned scope checks precede database access. */
export class AcknowledgementHttp {
  constructor(
    private readonly pages: PageAcknowledgements,
    private readonly allowed: (id: WorkspaceId) => boolean,
  ) {}
  async execute(
    method: "GET" | "POST",
    rawScope: string,
    authorization: string | undefined,
  ): Promise<AcknowledgementResult> {
    const scope = workspaceIdSchema.safeParse(rawScope);
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization ?? "");
    if (!scope.success || !match || !this.allowed(scope.data))
      return { state: "invalid" };
    return method === "GET"
      ? this.pages.preview(scope.data, match[1])
      : this.pages.acknowledge(scope.data, match[1]);
  }
}
