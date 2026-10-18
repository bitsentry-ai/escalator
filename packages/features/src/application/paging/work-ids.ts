import { createHash } from "node:crypto";
import type { WorkspaceId } from "../../contracts/index.js";

/** Stable across retries; domain separation avoids collisions between work kinds. */
export function pagingWorkId(
  scope: WorkspaceId,
  kind: string,
  ...keys: string[]
): string {
  return createHash("sha256")
    .update(JSON.stringify([scope, kind, ...keys]))
    .digest("hex");
}
