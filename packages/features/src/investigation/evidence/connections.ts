import { createHash } from "node:crypto";
import { z } from "zod";
import {
  investigationScopeSchema,
  opaqueIdSchema,
  investigationSourceOptionsInputSchema,
  type InvestigationSourceOptions,
  type InvestigationSourceOptionsQuery,
} from "../../contracts/index.js";
import type { ModelScope } from "../ports/index.js";
import { repositoryComparisonSchema } from "./github-diff.js";
const scopeSchema = investigationScopeSchema.pick({
  workspaceId: true,
  serviceId: true,
  environmentId: true,
});
/** Trusted host connection metadata only. No plaintext credentials or provider URLs.
 * Standalone operators supply these connections; Dashboard supplies canonical bindings.
 * The catalog grants no access by itself: hosts still check membership, target ownership,
 * enabled service/connection, secret permissions and the persisted live claim.
 */
export const repositoryConnectionSchema = z.strictObject({
  scope: scopeSchema,
  sourceId: opaqueIdSchema,
  name: z.string().trim().min(1).max(200),
  targetId: opaqueIdSchema,
  owner: repositoryComparisonSchema.shape.owner,
  repository: repositoryComparisonSchema.shape.repository,
  secretId: opaqueIdSchema.nullable(),
  enabled: z.boolean(),
});
export const repositoryConnectionsSchema = z
  .array(repositoryConnectionSchema)
  .max(256)
  .superRefine((connections, ctx) => {
    const keys = new Set<string>();
    for (const connection of connections) {
      const key = JSON.stringify([
        connection.scope.workspaceId,
        connection.sourceId,
      ]);
      if (keys.has(key))
        ctx.addIssue({
          code: "custom",
          message: "Duplicate repository source within workspace",
        });
      keys.add(key);
    }
  });
export type RepositoryConnection = z.infer<typeof repositoryConnectionSchema>;
function sameScope(left: ModelScope, right: ModelScope) {
  return (
    left.workspaceId === right.workspaceId &&
    left.serviceId === right.serviceId &&
    left.environmentId === right.environmentId
  );
}
/** Content-addressed connection versions prevent stale claims surviving an operator
 * edit that reuses the same source ID. Include the host target revision separately.
 */
export function repositoryConnectionRevision(
  input: RepositoryConnection,
  targetRevision: string,
): string {
  const connection = repositoryConnectionSchema.parse(input);
  const target = opaqueIdSchema.parse(targetRevision);
  return createHash("sha256")
    .update(JSON.stringify({ connection, targetRevision: target }))
    .digest("hex");
}
/** Immutable deployment snapshot, not an identity or secret registry. Every returned
 * object is a copy; consumers cannot mutate another run's approved connection.
 */
export class RepositoryConnections {
  private readonly connections: readonly RepositoryConnection[];
  constructor(input: unknown = []) {
    this.connections = repositoryConnectionsSchema.parse(input);
  }
  get(scope: ModelScope, sourceId: string): RepositoryConnection | undefined {
    const connection = this.connections.find(
      (value) => sameScope(value.scope, scope) && value.sourceId === sourceId,
    );
    return connection ? structuredClone(connection) : undefined;
  }
  list(
    workspaceId: ModelScope["workspaceId"],
    input: InvestigationSourceOptionsQuery,
  ): InvestigationSourceOptions {
    const query = investigationSourceOptionsInputSchema.parse(input);
    const scope = scopeSchema.parse({
      workspaceId,
      serviceId: query.serviceId,
      environmentId: query.environmentId,
    });
    if (query.kind !== "git_diff") return { items: [], next: null };
    const values = this.connections
      .filter(
        (value) =>
          sameScope(value.scope, scope) &&
          (!query.after || value.sourceId > query.after),
      )
      .sort((a, b) =>
        a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0,
      );
    const page = values.slice(0, query.limit);
    return {
      items: page.map((value) => ({
        kind: "git_diff" as const,
        sourceId: value.sourceId,
        name: value.name,
        enabled: value.enabled,
      })),
      next: values.length > query.limit ? page.at(-1)!.sourceId : null,
    };
  }
}
