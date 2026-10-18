import type { PoolClient } from "pg";
import {
  type WorkspaceId,
  type RuleLiveRecord,
  rulePolicyFactSchema,
} from "@bitsentry-escalator/features/contracts";
import {
  PersistenceError,
  resolveRulePolicy,
} from "@bitsentry-escalator/features/application";
import type { PostgresRulePolicyStore } from "./postgres-rule-live.store.js";
import { rulePolicySql } from "./rule-policy-sql.js";
const tables = {
  probe: "escalator_probe",
  metric: "escalator_metric_monitor",
  signal: "escalator_signal_source",
} as const;
/** Source -> periodic stream -> service -> binding -> policy, then the caller
 * locks runtime/page/claim. Reads and initial observations share that transaction.
 */
export function postgresRulePolicyStore(
  db: PoolClient,
  scope: WorkspaceId,
): PostgresRulePolicyStore {
  return {
    async lock(row: RuleLiveRecord) {
      const rule = row.version.definition;
      if (rule.workspaceId !== scope)
        throw new PersistenceError("scope_violation");
      const { kind, streamId } = rule.selector;
      const sourceColumn = kind === "signal" ? "id" : "source_id";
      const sql = `SELECT ${sourceColumn} AS source_id FROM ${tables[kind]} WHERE workspace_id=$1 AND id=$2 AND service_id=$3 AND environment_id=$4`;
      const args = [scope, streamId, rule.serviceId, rule.environmentId];
      const hint = await db.query<{ source_id: string }>(sql, args);
      if (!hint.rows[0]) throw new PersistenceError("not_found");
      const sourceId = hint.rows[0].source_id;
      const source = await db.query(
        "SELECT id FROM escalator_signal_source WHERE workspace_id=$1 AND id=$2 AND service_id=$3 AND environment_id=$4 FOR UPDATE",
        [scope, sourceId, rule.serviceId, rule.environmentId],
      );
      if (source.rows.length !== 1) throw new PersistenceError("not_found");
      const stream = await db.query<{ source_id: string }>(
        sql + " FOR SHARE",
        args,
      );
      if (stream.rows[0]?.source_id !== sourceId)
        throw new Error("Rule stream binding changed while locking");
      const service = await db.query(
        "SELECT id FROM escalator_service WHERE workspace_id=$1 AND id=$2 FOR SHARE",
        [scope, rule.serviceId],
      );
      if (service.rows.length !== 1) throw new PersistenceError("not_found");
      const binding = await db.query<{ id: string; policy_id: string | null }>(
        "SELECT id,policy_id FROM escalator_detection_binding WHERE workspace_id=$1 AND service_id=$2 AND environment_id=$3 FOR SHARE",
        [scope, rule.serviceId, rule.environmentId],
      );
      const policyId = binding.rows[0]?.policy_id;
      if (policyId) {
        const policy = await db.query(
          "SELECT id FROM escalator_policy WHERE workspace_id=$1 AND id=$2 AND service_id=$3 FOR SHARE",
          [scope, policyId, rule.serviceId],
        );
        if (policy.rows.length !== 1) throw new PersistenceError("not_found");
      }
      // Bootstrap only missing facts at the actual observation time. A first
      // decision may remain unknown; no original creation timestamp is reused.
      const observed: [string, string][] = [
        ["signal", sourceId],
        ["service", rule.serviceId],
      ];
      if (kind !== "signal") observed.push([kind, streamId]);
      if (binding.rows[0]) observed.push(["binding", binding.rows[0].id]);
      if (policyId) observed.push(["policy", policyId]);
      for (const [type, id] of observed)
        await db.query("SELECT escalator_observe_rule_policy($1,$2)::text", [
          type,
          id,
        ]);
    },
    async at(row, decisionAt) {
      const rule = row.version.definition;
      if (rule.workspaceId !== scope)
        throw new PersistenceError("scope_violation");
      const rows = await db.query<{ fact: unknown }>(rulePolicySql, [
        scope,
        rule.selector.kind,
        rule.selector.streamId,
        rule.serviceId,
        rule.environmentId,
        decisionAt,
      ]);
      return resolveRulePolicy(
        rule,
        decisionAt,
        rows.rows.map((value) => rulePolicyFactSchema.parse(value.fact)),
      );
    },
  };
}
