import { RepositoryConnections } from "@bitsentry-escalator/features/investigation";
/** One immutable operator-supplied snapshot. This is connection metadata, not a
 * credential store; private repositories reference existing opaque secret IDs.
 */
export function repositoryConnectionsFromJSON(raw: string | undefined) {
  try {
    if (raw !== undefined && Buffer.byteLength(raw, "utf8") > 262144)
      throw new Error("configuration exceeds 256 KiB");
    return new RepositoryConnections(raw === undefined ? [] : JSON.parse(raw));
  } catch {
    throw new Error("Invalid ESCALATOR_REPOSITORIES configuration");
  }
}
