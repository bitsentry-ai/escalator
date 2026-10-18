import type { AcknowledgementResult } from "../../contracts/index.js";
export interface AcknowledgementClient {
  preview(signal: AbortSignal): Promise<AcknowledgementResult>;
  acknowledge(signal: AbortSignal): Promise<AcknowledgementResult>;
}
/** Called before telemetry or host application initialization. Never persists the capability. */
export function captureAcknowledgement(
  location: Pick<Location, "pathname" | "hash" | "search">,
  history: Pick<History, "replaceState">,
) {
  const match = /^.*\/ack\/([^/]+)\/?$/.exec(location.pathname);
  const fragment = new URLSearchParams(location.hash.slice(1));
  const tokens = fragment.getAll("token");
  history.replaceState(null, "", location.pathname + location.search);
  if (!match || tokens.length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(tokens[0]))
    return undefined;
  let workspaceId: string;
  try {
    workspaceId = decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
  return { workspaceId, token: tokens[0] };
}
