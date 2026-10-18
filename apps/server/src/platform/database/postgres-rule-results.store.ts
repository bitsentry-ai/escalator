import type { PoolClient, QueryResultRow } from "pg";
import type {
  WorkspaceId,
  RuleResultsList,
} from "@bitsentry-escalator/features/contracts";
import {
  projectRuleReplayResult,
  projectRuleProposal,
  ruleResultJobId,
  ruleResultsJobStateSchema,
  type RuleResultsStore,
} from "@bitsentry-escalator/features/application";
type ReplayRow = { run: unknown; snapshot: unknown; report: unknown };
const replayProjection = `SELECT r.data AS run,
 jsonb_build_object('snapshotId',s.id,'inputHash',s.input_hash,'originalRetained',(s.data ? 'retained' AND NOT(s.data ? 'evaluation') AND NOT(s.data ? 'candidateEvaluation')),'version',s.data->'version','firstDecisionAt',s.data->'firstDecisionAt','lastDecisionAt',s.data->'lastDecisionAt') AS snapshot,
 CASE WHEN b.run_id IS NULL THEN NULL ELSE jsonb_build_object('runId',b.run_id,'snapshotId',b.snapshot_id,'inputHash',b.input_hash,'rule',b.data->'report'->'rule','summary',jsonb_build_object(
 'status',b.data->'report'->'status','reason',b.data->'report'->'reason','simulation',b.data->'report'->'simulation','range',b.data->'report'->'range','coverage',b.data->'report'->'coverage',
 'episodeCount',jsonb_array_length(b.data->'report'->'episodes'),'reviewedLabels',b.data->'report'->'reviewedLabels','unreviewedEpisodes',b.data->'report'->'unreviewedEpisodes','ambiguousEpisodes',b.data->'report'->'ambiguousEpisodes',
 'truePositives',b.data->'report'->'truePositives','falsePositives',b.data->'report'->'falsePositives','missedLabels',jsonb_array_length(b.data->'report'->'missedLabelIds'),'unevaluableLabels',jsonb_array_length(b.data->'report'->'unevaluableLabelIds'),
 'precision',b.data->'report'->'precision','labelCoverage',b.data->'report'->'labelCoverage')) END AS report
 FROM escalator_rule_replay_run r JOIN escalator_rule_replay_snapshot s ON(s.workspace_id,s.id,s.input_hash)=(r.workspace_id,r.snapshot_id,r.input_hash)
 LEFT JOIN escalator_rule_backtest b ON(b.workspace_id,b.run_id,b.snapshot_id,b.input_hash)=(r.workspace_id,r.id,r.snapshot_id,r.input_hash)`;
const proposalProjection = `SELECT p.data,s.service_id,s.environment_id FROM escalator_rule_proposal p JOIN escalator_rule_replay_snapshot s ON(s.workspace_id,s.id,s.input_hash)=(p.workspace_id,p.source_snapshot_id,p.source_input_hash)`;
export function postgresRuleResultsStore(
  db: PoolClient,
  scope: WorkspaceId,
): RuleResultsStore {
  async function query<T extends QueryResultRow>(
    sql: string,
    values: unknown[],
  ) {
    return (await db.query<T>(sql, values)).rows;
  }
  async function replays(sql: string, values: unknown[]) {
    const rows = await query<ReplayRow>(sql, values);
    const ids = rows.map((r) => ruleResultJobId(scope, r.run));
    const jobs = ids.length
      ? await query<{ id: string; state: unknown }>(
          "SELECT id,state FROM escalator_job WHERE workspace_id=$1 AND id=ANY($2::text[])",
          [scope, ids],
        )
      : [];
    const states = new Map(
      jobs.map((j) => [j.id, ruleResultsJobStateSchema.parse(j.state)]),
    );
    return rows.map((r, i) =>
      projectRuleReplayResult(
        scope,
        r.run,
        r.snapshot,
        r.report,
        states.get(ids[i]),
      ),
    );
  }
  async function proposals(sql: string, values: unknown[]) {
    const rows = await query<{
      data: unknown;
      service_id: string;
      environment_id: string;
    }>(sql, values);
    return rows.map((r) =>
      projectRuleProposal(scope, r.data, r.service_id, r.environment_id),
    );
  }
  function params(input: RuleResultsList) {
    return [
      scope,
      input.serviceId,
      input.environmentId,
      input.ruleId ?? null,
      input.after ?? null,
      input.limit + 1,
    ];
  }
  return {
    replays: (input) =>
      replays(
        replayProjection +
          " WHERE r.workspace_id=$1 AND s.service_id=$2 AND s.environment_id=$3 AND ($4::text IS NULL OR s.data->'version'->>'id'=$4) AND ($5::text IS NULL OR r.id>$5) ORDER BY r.id LIMIT $6::integer",
        params(input),
      ),
    async replay(id) {
      return (
        await replays(
          replayProjection + " WHERE r.workspace_id=$1 AND r.id=$2",
          [scope, id],
        )
      )[0];
    },
    proposals: (input) =>
      proposals(
        proposalProjection +
          " WHERE p.workspace_id=$1 AND s.service_id=$2 AND s.environment_id=$3 AND ($4::text IS NULL OR p.candidate_id=$4) AND ($5::text IS NULL OR p.id>$5) ORDER BY p.id LIMIT $6::integer",
        params(input),
      ),
    async proposal(id) {
      return (
        await proposals(
          proposalProjection + " WHERE p.workspace_id=$1 AND p.id=$2",
          [scope, id],
        )
      )[0];
    },
  };
}
