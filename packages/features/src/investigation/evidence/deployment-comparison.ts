import { z } from "zod";
import {
  investigationScopeSchema,
  evidenceQuerySchema,
  deploymentSchema,
  opaqueIdSchema,
  utcTimestampSchema,
  type InvestigationScope,
  type EvidenceQuery,
} from "../../contracts/index.js";
import {
  repositoryConnectionSchema,
  type RepositoryConnection,
} from "./connections.js";
import {
  repositoryComparisonSchema,
  type RepositoryComparison,
} from "./github-diff.js";
import { GithubDiffError } from "./github-http.js";
const rowSchema = z.strictObject({
  targetId: opaqueIdSchema,
  record: deploymentSchema,
});
/** Hosts select the latest accepted start in the requested window for this exact
 * target, and its latest successful predecessor completed before that start.
 * They must bound SQL materialization and validate the live claim around provider I/O.
 * This helper validates the selected rows; it cannot prove the host selected the latest.
 */
export function repositoryComparisonFromDeployments(
  scopeInput: InvestigationScope,
  queryInput: EvidenceQuery,
  connectionInput: RepositoryConnection,
  headInput: unknown,
  baseInput: unknown,
  asOfInput: string,
): RepositoryComparison {
  try {
    const scope = investigationScopeSchema.parse(scopeInput),
      query = evidenceQuerySchema.parse(queryInput),
      connection = repositoryConnectionSchema.parse(connectionInput),
      asOf = utcTimestampSchema.parse(asOfInput);
    const same = (value: {
      workspaceId: string;
      serviceId: string;
      environmentId: string;
    }) =>
      value.workspaceId === scope.workspaceId &&
      value.serviceId === scope.serviceId &&
      value.environmentId === scope.environmentId;
    if (
      !same(connection.scope) ||
      !connection.enabled ||
      query.kind !== "git_diff" ||
      query.sourceId !== connection.sourceId
    )
      throw new GithubDiffError("not_authorized");
    if (
      headInput === null ||
      headInput === undefined ||
      baseInput === null ||
      baseInput === undefined
    )
      throw new GithubDiffError("not_found");
    const head = rowSchema.parse(headInput),
      base = rowSchema.parse(baseInput);
    if (
      !same(head.record) ||
      !same(base.record) ||
      head.targetId !== connection.targetId ||
      base.targetId !== connection.targetId
    )
      throw new GithubDiffError("not_authorized");
    const current = head.record,
      previous = base.record;
    if (
      current.id === previous.id ||
      previous.status !== "SUCCEEDED" ||
      !previous.finish ||
      Date.parse(current.startedAt) < Date.parse(query.window.from) ||
      Date.parse(current.startedAt) > Date.parse(query.window.to) ||
      Date.parse(current.acceptedAt) > Date.parse(asOf) ||
      Date.parse(previous.finish.occurredAt) > Date.parse(current.startedAt) ||
      Date.parse(previous.finish.receivedAt) > Date.parse(current.acceptedAt)
    )
      throw new GithubDiffError("invalid_response");
    if (
      !current.commit ||
      !previous.commit ||
      !/^[a-f0-9]{40}$/.test(current.commit) ||
      !/^[a-f0-9]{40}$/.test(previous.commit)
    )
      throw new GithubDiffError("invalid_configuration");
    return repositoryComparisonSchema.parse({
      scope,
      sourceId: connection.sourceId,
      owner: connection.owner,
      repository: connection.repository,
      baseSha: previous.commit,
      headSha: current.commit,
      observedAt: current.startedAt,
      deploymentReceivedAt: current.acceptedAt,
    });
  } catch (error) {
    if (error instanceof GithubDiffError) throw error;
    throw new GithubDiffError("invalid_response");
  }
}
