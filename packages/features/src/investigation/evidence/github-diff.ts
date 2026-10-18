import { z } from "zod";
import {
  investigationScopeSchema,
  evidenceQuerySchema,
  utcTimestampSchema,
  opaqueIdSchema,
  investigationEvidenceSchema,
  type InvestigationScope,
  type EvidenceQuery,
  type InvestigationEvidence,
} from "../../contracts/index.js";
import type { EvidenceReader } from "../ports/index.js";
import { pagingWorkId } from "../../application/paging/work-ids.js";
import { redactEvidence } from "./redaction.js";
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const segment = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_.-]+$/)
  .refine(
    (value) => value !== "." && value !== "..",
    "Invalid repository path segment",
  );
/** Host-authorized immutable comparison, selected from persisted deployment history.
 * This describes provenance, not permission. Hosts must check the live claim and
 * connection revision before and after reading the provider, outside SQL transactions.
 */
export const repositoryComparisonSchema = z.strictObject({
  scope: investigationScopeSchema,
  sourceId: opaqueIdSchema,
  owner: segment,
  repository: segment,
  baseSha: sha,
  headSha: sha,
  observedAt: utcTimestampSchema,
  deploymentReceivedAt: utcTimestampSchema,
});
export type RepositoryComparison = z.infer<typeof repositoryComparisonSchema>;
const fileSchema = z.object({
  filename: z.string().min(1).max(4096),
  previous_filename: z.string().min(1).max(4096).optional(),
  status: z.enum([
    "added",
    "removed",
    "modified",
    "renamed",
    "copied",
    "changed",
    "unchanged",
  ]),
  additions: z.number().int().nonnegative().max(2147483647),
  deletions: z.number().int().nonnegative().max(2147483647),
  changes: z.number().int().nonnegative().max(2147483647),
  patch: z.string().max(262144).optional(),
});
const comparisonSchema = z.object({
  status: z.enum(["ahead", "identical", "behind", "diverged"]),
  ahead_by: z.number().int().nonnegative(),
  behind_by: z.number().int().nonnegative(),
  total_commits: z.number().int().min(0).max(250),
  base_commit: z.object({ sha }),
  merge_base_commit: z.object({ sha }),
  commits: z.array(z.object({ sha })).max(250),
  files: z.array(fileSchema).max(300),
});
type Outcome = Awaited<ReturnType<EvidenceReader["read"]>>;
function patchIncomplete(file: z.infer<typeof fileSchema>): boolean {
  if (file.patch === undefined) return true;
  const lines = file.patch.split("\n");
  return (
    lines.filter((line) => line.startsWith("+")).length !== file.additions ||
    lines.filter((line) => line.startsWith("-")).length !== file.deletions ||
    file.changes !== file.additions + file.deletions
  );
}
/** Accepts a bounded UTF-8 JSON body from the approved compare endpoint only.
 * No response URL, author metadata, message, or executable tool definition is retained.
 * Receipt time is this retrieval, not the earlier deployment receipt.
 * Diverged/rollback and incomplete commit lists are unavailable, not an exact deploy diff.
 */
export function normalizeGithubDiff(
  scopeInput: InvestigationScope,
  queryInput: EvidenceQuery,
  comparisonInput: RepositoryComparison,
  body: string,
  collectedAtInput: string,
  maxBytes: number,
  knownSecrets: readonly string[] = [],
): Outcome {
  const scope = investigationScopeSchema.parse(scopeInput);
  const query = evidenceQuerySchema.parse(queryInput);
  const collectedAt = utcTimestampSchema.parse(collectedAtInput);
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 262144)
    throw new RangeError("Invalid evidence byte limit");
  const unavailable = (
    reason: "invalid_response" | "not_authorized" | "budget_exhausted",
  ): Outcome => ({ status: "unavailable", unavailable: { query, reason } });
  try {
    const comparison = repositoryComparisonSchema.parse(comparisonInput);
    if (
      query.kind !== "git_diff" ||
      comparison.sourceId !== query.sourceId ||
      Object.keys(scope).some(
        (key) =>
          scope[key as keyof InvestigationScope] !==
          comparison.scope[key as keyof InvestigationScope],
      )
    )
      return unavailable("not_authorized");
    if (
      Date.parse(comparison.observedAt) < Date.parse(query.window.from) ||
      Date.parse(comparison.observedAt) > Date.parse(query.window.to) ||
      Date.parse(comparison.observedAt) > Date.parse(collectedAt) ||
      Date.parse(comparison.deploymentReceivedAt) > Date.parse(collectedAt) ||
      typeof body !== "string" ||
      Buffer.byteLength(body, "utf8") > 1048576
    )
      return unavailable("invalid_response");
    const value = comparisonSchema.parse(JSON.parse(body));
    const identical = comparison.baseSha === comparison.headSha;
    if (
      value.base_commit.sha !== comparison.baseSha ||
      value.merge_base_commit.sha !== comparison.baseSha ||
      value.behind_by !== 0 ||
      value.ahead_by !== value.total_commits ||
      value.commits.length !== value.total_commits ||
      value.status !== (identical ? "identical" : "ahead") ||
      (identical
        ? value.total_commits !== 0 || value.files.length !== 0
        : value.total_commits === 0 ||
          value.commits.at(-1)?.sha !== comparison.headSha) ||
      new Set(value.commits.map((commit) => commit.sha)).size !==
        value.commits.length ||
      new Set(value.files.map((file) => file.filename)).size !==
        value.files.length
    )
      return unavailable("invalid_response");
    const missingPatches = value.files.filter(
      (file) => file.patch === undefined,
    ).length;
    const incompletePatches = value.files.filter(patchIncomplete).length;
    const capped = value.files.length === 300;
    const candidates: InvestigationEvidence[] = [];
    const add = (key: string, facts: unknown, incomplete: boolean) => {
      const redacted = redactEvidence(JSON.stringify(facts), knownSecrets);
      // Preserve redacted text only. Do not clip the original before redaction: a
      // credential spanning the clipping boundary must not become a visible prefix.
      let text = redacted.text;
      const clipped = text.length > 16384;
      if (clipped) {
        text = text.slice(0, 16383);
        if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
        text += "…";
      }
      candidates.push(
        investigationEvidenceSchema.parse({
          scope,
          window: query.window,
          collectedAt,
          reference: {
            id: pagingWorkId(
              scope.workspaceId,
              "github-diff",
              scope.serviceId,
              scope.environmentId,
              comparison.sourceId,
              comparison.owner,
              comparison.repository,
              comparison.baseSha,
              comparison.headSha,
              key,
            ),
            kind: "git_diff",
            sourceId: query.sourceId,
            observedAt: comparison.observedAt,
            receivedAt: collectedAt,
          },
          text,
          truncated: incomplete || redacted.truncated || clipped,
        }),
      );
    };
    add(
      "summary",
      {
        repository: comparison.owner + "/" + comparison.repository,
        baseSha: comparison.baseSha,
        headSha: comparison.headSha,
        comparison: value.status,
        deploymentReceivedAt: comparison.deploymentReceivedAt,
        returnedFiles: value.files.length,
        fileListMayBeCapped: capped,
        missingPatches,
        incompletePatches,
        fileEvidenceLimit: query.limit - 1,
      },
      capped || incompletePatches > 0 || value.files.length >= query.limit,
    );
    for (const file of value.files.slice(0, query.limit - 1)) {
      // API files can be binary or too large for a patch. Metadata is still useful,
      // but never claim that absent patch text means unchanged content.
      add(
        "file:" + file.filename,
        {
          filename: file.filename,
          previousFilename: file.previous_filename ?? null,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
          patch: file.patch ?? null,
          patchUnavailable: file.patch === undefined,
          patchIncomplete: patchIncomplete(file),
        },
        patchIncomplete(file),
      );
    }
    const items: InvestigationEvidence[] = [];
    let bytes = 2;
    let truncated =
      capped || incompletePatches > 0 || value.files.length >= query.limit;
    for (const candidate of candidates) {
      const size =
        Buffer.byteLength(JSON.stringify(candidate), "utf8") +
        (items.length ? 1 : 0);
      if (bytes + size > maxBytes) {
        truncated = true;
        break;
      }
      items.push(candidate);
      bytes += size;
      truncated ||= candidate.truncated;
    }
    return items.length
      ? { status: "available", items, truncated }
      : unavailable("budget_exhausted");
  } catch {
    return unavailable("invalid_response");
  }
}
