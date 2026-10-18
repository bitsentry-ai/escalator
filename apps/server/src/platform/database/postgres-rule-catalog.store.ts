import type { PoolClient } from "pg";
import {
  detectionRuleVersionSchema,
  ruleLiveRecordSchema,
  type WorkspaceId,
  type DetectionRuleVersion,
} from "@bitsentry-escalator/features/contracts";
import {
  encodeRuleCatalogData,
  decodeRuleCatalogData,
  PersistenceError,
  type RuleCatalogStore,
} from "@bitsentry-escalator/features/application";
export function postgresRuleCatalogStore(
  db: PoolClient,
  scope: WorkspaceId,
  bindings: Pick<RuleCatalogStore, "lockDefinition" | "evidence">,
): RuleCatalogStore {
  async function read(id: string, lock = false) {
    const r = await db.query<{ data: unknown }>(
      "SELECT data FROM escalator_rule_catalog WHERE workspace_id=$1 AND id=$2" +
        (lock ? " FOR UPDATE" : ""),
      [scope, id],
    );
    return r.rows[0]
      ? decodeRuleCatalogData(scope, "catalog", r.rows[0].data)
      : undefined;
  }
  async function version(id: string, revision: number) {
    const r = await db.query<{ definition: Record<string, unknown> }>(
      "SELECT definition FROM escalator_rule_version WHERE workspace_id=$1 AND rule_id=$2 AND revision=$3::bigint",
      [scope, id, revision],
    );
    return r.rows[0]
      ? detectionRuleVersionSchema.parse({
          id,
          revision,
          definition: { ...r.rows[0].definition, workspaceId: scope },
        })
      : undefined;
  }
  async function insertVersion(raw: DetectionRuleVersion) {
    const v = detectionRuleVersionSchema.parse(raw),
      d = v.definition;
    if (d.workspaceId !== scope) throw new PersistenceError("scope_violation");
    await db.query(
      "INSERT INTO escalator_rule_version(workspace_id,rule_id,revision,service_id,environment_id,definition) VALUES($1,$2,$3::bigint,$4,$5,$6::jsonb-'workspaceId')",
      [
        scope,
        v.id,
        v.revision,
        d.serviceId,
        d.environmentId,
        JSON.stringify(d),
      ],
    );
  }
  return {
    lockDefinition: bindings.lockDefinition,
    evidence: bindings.evidence,
    async currentTime() {
      const r = await db.query<{ now: string }>(
        `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now`,
      );
      return r.rows[0]!.now;
    },
    async lock(id) {
      const hint = await read(id);
      if (!hint) return undefined;
      const v = await version(id, hint.versionRevision);
      if (!v) throw new PersistenceError("not_found");
      await bindings.lockDefinition(v);
      const row = await read(id, true);
      if (!row || row.revision !== hint.revision)
        throw new Error("Rule changed during lock acquisition");
      return row;
    },
    version,
    async latestVersionRevision(id) {
      const r = await db.query<{ revision: string | null }>(
        "SELECT max(revision)::text AS revision FROM escalator_rule_version WHERE workspace_id=$1 AND rule_id=$2",
        [scope, id],
      );
      if (!r.rows[0]?.revision) throw new PersistenceError("not_found");
      return Number(r.rows[0].revision);
    },
    insertVersion,
    async insert(entry, v) {
      const data = encodeRuleCatalogData(scope, "catalog", entry);
      if (
        entry.status !== "draft" ||
        entry.revision !== 1 ||
        entry.versionRevision !== 1 ||
        entry.generation !== 0 ||
        entry.createdAt !== entry.updatedAt
      )
        throw new Error("Invalid initial rule draft");
      if (
        v.id !== entry.id ||
        v.revision !== entry.versionRevision ||
        v.definition.serviceId !== entry.serviceId ||
        v.definition.environmentId !== entry.environmentId
      )
        throw new PersistenceError("scope_violation");
      await insertVersion(v);
      await db.query(
        "INSERT INTO escalator_rule_catalog(workspace_id,id,service_id,environment_id,revision,version_revision,generation,status,origin_proposal_id,created_at,updated_at,data) VALUES($1,$2,$3,$4,$5::bigint,$6::bigint,$7::bigint,$8,$9,$10::timestamptz,$11::timestamptz,$12::jsonb)",
        [
          scope,
          entry.id,
          entry.serviceId,
          entry.environmentId,
          entry.revision,
          entry.versionRevision,
          entry.generation,
          entry.status,
          entry.originProposalId,
          entry.createdAt,
          entry.updatedAt,
          data,
        ],
      );
    },
    async save(entry, expected) {
      const data = encodeRuleCatalogData(scope, "catalog", entry);
      const r = await db.query(
        "UPDATE escalator_rule_catalog SET revision=$3::bigint,version_revision=$4::bigint,generation=$5::bigint,status=$6,updated_at=$7::timestamptz,data=$8::jsonb WHERE workspace_id=$1 AND id=$2 AND revision=$9::bigint",
        [
          scope,
          entry.id,
          entry.revision,
          entry.versionRevision,
          entry.generation,
          entry.status,
          entry.updatedAt,
          data,
          expected,
        ],
      );
      return r.rowCount === 1;
    },
    async runtime(id) {
      const r = await db.query<{ data: unknown }>(
        `SELECT r.data || jsonb_build_object('version',jsonb_build_object('id',v.rule_id,'revision',v.revision,'definition',v.definition||jsonb_build_object('workspaceId',$1::text)),'state',CASE WHEN r.data->'state'='null'::jsonb THEN 'null'::jsonb ELSE r.data->'state'||jsonb_build_object('workspaceId',$1::text) END) AS data FROM escalator_rule_runtime r JOIN escalator_rule_version v ON(v.workspace_id,v.rule_id,v.revision)=(r.workspace_id,r.rule_id,r.rule_revision) WHERE r.workspace_id=$1 AND r.rule_id=$2 AND r.retired_at IS NULL FOR UPDATE OF r`,
        [scope, id],
      );
      return r.rows[0] ? ruleLiveRecordSchema.parse(r.rows[0].data) : undefined;
    },
    async retireRuntime(id) {
      await db.query(
        "UPDATE escalator_rule_runtime SET retired_at=clock_timestamp(),revision=revision+1,data=jsonb_set(data,'{revision}',to_jsonb(revision+1)) WHERE workspace_id=$1 AND rule_id=$2 AND retired_at IS NULL",
        [scope, id],
      );
    },
    async activateRuntime(raw) {
      const row = ruleLiveRecordSchema.parse(raw),
        v = row.version,
        d = v.definition;
      if (d.workspaceId !== scope)
        throw new PersistenceError("scope_violation");
      if (row.revision !== 1 || row.state !== null || row.incidentId !== null)
        throw new Error("Activation requires fresh runtime state");
      const r = await db.query(
        `INSERT INTO escalator_rule_runtime(workspace_id,rule_id,rule_revision,generation,revision,service_id,environment_id,incident_id,due_at,retired_at,data) VALUES($1,$2,$3::bigint,$4::bigint,1,$5,$6,NULL,$7::timestamptz,NULL,($8::jsonb-'version') #- '{state,workspaceId}') ON CONFLICT(workspace_id,rule_id) DO UPDATE SET rule_revision=EXCLUDED.rule_revision,generation=EXCLUDED.generation,revision=1,service_id=EXCLUDED.service_id,environment_id=EXCLUDED.environment_id,incident_id=NULL,due_at=EXCLUDED.due_at,retired_at=NULL,data=EXCLUDED.data WHERE escalator_rule_runtime.retired_at IS NOT NULL`,
        [
          scope,
          v.id,
          v.revision,
          row.generation,
          d.serviceId,
          d.environmentId,
          row.dueAt,
          JSON.stringify(row),
        ],
      );
      if (r.rowCount !== 1) throw new Error("Rule runtime was not retired");
    },
    async review(id) {
      const r = await db.query<{ data: unknown }>(
        "SELECT data FROM escalator_rule_review WHERE workspace_id=$1 AND id=$2 FOR SHARE",
        [scope, id],
      );
      return r.rows[0]
        ? decodeRuleCatalogData(scope, "review", r.rows[0].data)
        : undefined;
    },
    async insertReview(row) {
      const data = encodeRuleCatalogData(scope, "review", row);
      // Source/catalog lock is held. Cleanup never removes a referenced receipt.
      await db.query(
        `DELETE FROM escalator_rule_review WHERE workspace_id=$1 AND id IN (SELECT r.id FROM escalator_rule_review r WHERE r.workspace_id=$1 AND r.rule_id=$2 AND r.expires_at<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM escalator_rule_activation h WHERE h.workspace_id=$1 AND h.receipt_id=r.id) ORDER BY r.expires_at,r.id LIMIT 100)`,
        [scope, row.ruleId],
      );
      const count = await db.query<{ n: number }>(
        "SELECT count(*)::integer AS n FROM (SELECT id FROM escalator_rule_review WHERE workspace_id=$1 AND rule_id=$2 AND expires_at>clock_timestamp() LIMIT 16) pending",
        [scope, row.ruleId],
      );
      if (!count.rows[0] || count.rows[0].n >= 16)
        throw new Error("Too many unexpired rule reviews");
      await db.query(
        "INSERT INTO escalator_rule_review(workspace_id,id,rule_id,catalog_revision,version_revision,reviewed_by,mode,run_id,created_at,expires_at,data) VALUES($1,$2,$3,$4::bigint,$5::bigint,$6,$7,$8,$9::timestamptz,$10::timestamptz,$11::jsonb)",
        [
          scope,
          row.id,
          row.ruleId,
          row.catalogRevision,
          row.versionRevision,
          row.reviewedBy,
          row.mode,
          row.runId,
          row.createdAt,
          row.expiresAt,
          data,
        ],
      );
    },
    async history(row) {
      const data = encodeRuleCatalogData(scope, "history", row);
      await db.query(
        "INSERT INTO escalator_rule_activation(workspace_id,id,rule_id,catalog_revision,version_revision,generation,action,actor_id,previous_version_revision,previous_incident_id,receipt_id,recorded_at,data) VALUES($1,$2,$3,$4::bigint,$5::bigint,$6::bigint,$7,$8,$9::bigint,$10,$11,$12::timestamptz,$13::jsonb)",
        [
          scope,
          row.id,
          row.ruleId,
          row.catalogRevision,
          row.versionRevision,
          row.generation,
          row.action,
          row.actorId,
          row.previousVersionRevision,
          row.previousIncidentId,
          row.receiptId,
          row.recordedAt,
          data,
        ],
      );
    },
  };
}
