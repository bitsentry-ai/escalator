import type { PoolClient } from "pg";
import {
  incidentLabelSchema,
  rulePolicyFactSchema,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import {
  buildRuleReviewEvidence,
  assertRuleCatalogProposal,
  decodeRuleProposal,
  PersistenceError,
  type RuleCatalogStore,
  type FoundationTransaction,
} from "@bitsentry-escalator/features/application";
import { postgresRuleReplayStore } from "./postgres-rule-replay.store.js";
import { postgresRuleBacktestStore } from "./postgres-rule-backtest.store.js";
import { postgresRuleReplayCaptureStore } from "./postgres-rule-replay-capture.store.js";
import { rulePolicySql } from "./rule-policy-sql.js";
import { ruleMeasurementHashSql } from "./rule-replay-capture-sql.js";
export function postgresRuleReviewEvidence(
  db: PoolClient,
  scope: WorkspaceId,
  base: FoundationTransaction,
): RuleCatalogStore["evidence"] {
  const replay = postgresRuleReplayStore(db, scope),
    reports = postgresRuleBacktestStore(db, scope),
    capture = postgresRuleReplayCaptureStore(db, scope);
  return async (entry, version, runId) => {
    const d = version.definition;
    if (
      entry.workspaceId !== scope ||
      d.workspaceId !== scope ||
      version.id !== entry.id ||
      d.serviceId !== entry.serviceId ||
      d.environmentId !== entry.environmentId
    )
      throw new PersistenceError("scope_violation");
    // Proposal lock precedes replay rows, matching evaluation finalization.
    if (entry.originProposalId) {
      const p = await db.query<{ data: unknown }>(
        "SELECT data FROM escalator_rule_proposal WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [scope, entry.originProposalId],
      );
      if (!p.rows[0]) throw new PersistenceError("not_found");
      const v = await db.query<{ definition: Record<string, unknown> }>(
        "SELECT definition FROM escalator_rule_version WHERE workspace_id=$1 AND rule_id=$2 AND revision=1",
        [scope, entry.id],
      );
      if (!v.rows[0]) throw new PersistenceError("not_found");
      await assertRuleCatalogProposal(
        { ...base, replay, reports },
        entry,
        {
          id: entry.id,
          revision: 1,
          definition: { ...v.rows[0].definition, workspaceId: scope },
        },
        decodeRuleProposal(scope, p.rows[0].data),
      );
    }
    const now = await replay.currentTime();
    const measurement = await db.query<{ hash: string }>(
      ruleMeasurementHashSql(d.selector.kind),
      [scope, d.selector.streamId, d.serviceId, d.environmentId],
    );
    if (!measurement.rows[0]) throw new PersistenceError("not_found");
    const facts = await db.query<{ fact: unknown }>(rulePolicySql, [
      scope,
      d.selector.kind,
      d.selector.streamId,
      d.serviceId,
      d.environmentId,
      now,
    ]);
    const current = facts.rows.map((r) => rulePolicyFactSchema.parse(r.fact));
    if (runId === null)
      return buildRuleReviewEvidence(
        version,
        now,
        measurement.rows[0].hash,
        current,
        null,
      );
    const run = await replay.lock(runId),
      report = await reports.get(runId);
    if (!run || !report) throw new PersistenceError("not_found");
    const snapshot = await replay.snapshot(run.snapshotId);
    if (!snapshot?.snapshot.retained)
      throw new Error("Retained review capture unavailable");
    const history = snapshot.snapshot.retained.history;
    const fresh = await capture.evidence(version, {
      startAt: history.startAt,
      endAt: history.endAt,
      visibleAt: now,
    });
    const rows = await db.query<{ data: Record<string, unknown> }>(
      `SELECT data FROM escalator_incident_label WHERE workspace_id=$1 AND service_id=$2 AND environment_id=$3 AND stream_kind=$4 AND stream_id=$5 AND status='reviewed' AND (data->>'reviewedAt')::timestamptz<=$6::timestamptz AND (data->>'startedAt')::timestamptz<=$8::timestamptz AND (data->>'endedAt')::timestamptz>$7::timestamptz ORDER BY id LIMIT 1001`,
      [
        scope,
        d.serviceId,
        d.environmentId,
        d.selector.kind,
        d.selector.streamId,
        now,
        snapshot.snapshot.firstDecisionAt,
        snapshot.snapshot.lastDecisionAt,
      ],
    );
    if (rows.rows.length > 1000)
      throw new Error("Reviewed label bound exceeded");
    const labels = rows.rows.map((r) =>
      incidentLabelSchema.parse({ ...r.data, workspaceId: scope }),
    );
    return buildRuleReviewEvidence(
      version,
      now,
      measurement.rows[0].hash,
      current,
      { run, snapshot, report, fresh, labels },
    );
  };
}
