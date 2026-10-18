import type {
  InvestigationScope,
  EvidenceQuery,
  UnavailableEvidence,
} from "../../contracts/index.js";
import type { EvidenceReader, OperationContext } from "../ports/index.js";
import { GithubDiffHttp, GithubDiffError } from "./github-http.js";
import {
  normalizeGithubDiff,
  repositoryComparisonSchema,
  type RepositoryComparison,
} from "./github-diff.js";
import { ValidatedEvidenceReader } from "./validated-reader.js";
/** Host-bound to one persisted claim, not an ambient repository credential service.
 * Recheck captured source/target/secret bindings and database lease before and after
 * operation. Commit each short database read before broker/provider I/O. Resolve only
 * that connection's opaque secret; pass undefined only for configured public access.
 * Return undefined after failed authorization, including revocation during the read.
 */
export interface RepositoryEvidenceAccess {
  use<T>(
    scope: InvestigationScope,
    query: EvidenceQuery,
    context: OperationContext,
    operation: (
      comparison: RepositoryComparison,
      token: string | undefined,
    ) => Promise<T>,
  ): Promise<T | undefined>;
}
type Outcome = Awaited<ReturnType<EvidenceReader["read"]>>;
export class RepositoryEvidenceReader implements EvidenceReader {
  private readonly reader: ValidatedEvidenceReader;
  constructor(
    access: RepositoryEvidenceAccess,
    transport: Pick<GithubDiffHttp, "read"> = new GithubDiffHttp(),
    now: () => Date = () => new Date(),
  ) {
    this.reader = new ValidatedEvidenceReader({
      read: async (scope, query, context) => {
        const unavailable = (
          reason: UnavailableEvidence["reason"],
        ): Outcome => ({
          status: "unavailable",
          unavailable: { query, reason },
        });
        if (query.kind !== "git_diff") return unavailable("not_configured");
        const deadline = performance.now() + context.timeoutMs;
        let used = false;
        try {
          const result = await access.use(
            scope,
            query,
            context,
            async (input, token) => {
              context.signal.throwIfAborted();
              if (used) return unavailable("not_authorized");
              used = true;
              const parsed = repositoryComparisonSchema.safeParse(input);
              if (!parsed.success) return unavailable("not_authorized");
              const comparison = parsed.data;
              if (
                comparison.sourceId !== query.sourceId ||
                (Object.keys(scope) as Array<keyof InvestigationScope>).some(
                  (key) => scope[key] !== comparison.scope[key],
                ) ||
                Date.parse(comparison.observedAt) <
                  Date.parse(query.window.from) ||
                Date.parse(comparison.observedAt) > Date.parse(query.window.to)
              )
                return unavailable("not_authorized");
              const before = now().getTime();
              if (
                !Number.isFinite(before) ||
                Date.parse(comparison.observedAt) > before ||
                Date.parse(comparison.deploymentReceivedAt) > before
              )
                return unavailable("invalid_response");
              const timeoutMs = Math.min(
                10000,
                Math.floor(deadline - performance.now()),
              );
              if (timeoutMs < 1) return unavailable("timeout");
              const body = await transport.read(comparison, token, {
                signal: context.signal,
                timeoutMs,
              });
              context.signal.throwIfAborted();
              return normalizeGithubDiff(
                scope,
                query,
                comparison,
                body,
                now().toISOString(),
                context.maxBytes,
                token === undefined ? [] : [token],
              );
            },
          );
          context.signal.throwIfAborted();
          return result ?? unavailable("not_authorized");
        } catch (error) {
          if (context.signal.aborted) return unavailable("cancelled");
          if (error instanceof GithubDiffError)
            return unavailable(
              error.reason === "invalid_configuration"
                ? "not_configured"
                : error.reason,
            );
          return unavailable("unreachable");
        }
      },
    });
  }
  read(
    scope: InvestigationScope,
    query: EvidenceQuery,
    context: OperationContext & { maxBytes: number },
  ) {
    return this.reader.read(scope, query, context);
  }
}
