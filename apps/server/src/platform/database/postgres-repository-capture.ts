import { readRepositoryBinding } from "./postgres-repository-evidence.js";
import type { PoolClient } from "pg";
import {
  investigationSourceSelectionSchema,
  type InvestigationSourceSelection,
} from "@bitsentry-escalator/features/contracts";
import {
  RepositoryConnections,
  type ModelScope,
  type InvestigationConfiguration,
} from "@bitsentry-escalator/features/investigation";
/** Called while the first-page transaction holds the settings row. One bounded
 * metadata snapshot, no row-lock inversion with source editors, metadata-only secret checks.
 * The runner subsequently authorizes the captured bindings under its live claim.
 */
export async function captureRepositorySources(
  db: PoolClient,
  scope: ModelScope,
  selections: readonly InvestigationSourceSelection[],
  connections: RepositoryConnections,
) {
  const requested = investigationSourceSelectionSchema
    .array()
    .max(32)
    .parse(selections)
    .filter((source) => source.kind === "git_diff");
  const sourceVersions: InvestigationConfiguration["sourceVersions"] = [];
  const secretIds = new Set<string>();
  for (const source of requested) {
    const available = await readRepositoryBinding(
      db,
      scope,
      source.sourceId,
      connections,
      false,
    );
    sourceVersions.push({
      kind: "git_diff",
      sourceId: source.sourceId,
      revision: available?.revision ?? "missing",
    });
    if (available && available.connection.secretId !== null)
      secretIds.add(available.connection.secretId);
  }
  return { sourceVersions, secretIds: [...secretIds] };
}
