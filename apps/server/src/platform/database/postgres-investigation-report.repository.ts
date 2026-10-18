import type { Pool } from "pg";
import {
  opaqueIdSchema,
  investigationScopeSchema,
  type Actor,
} from "@bitsentry-escalator/features/contracts";
import type { InvestigationReportRepository } from "@bitsentry-escalator/features/application";
import { investigationTransaction } from "./investigation-transaction.js";
interface Row {
  incident_id: string;
  service_id: string;
  environment_id: string;
  observed_at: Date;
  id: string | null;
  state: string | null;
  attempt_count: number | null;
  created_at: Date | null;
  updated_at: Date | null;
  lease_expires_at: Date | null;
  destination: unknown;
  report: unknown;
  evidence: unknown;
}
function snapshot(workspaceId: Actor["workspaceId"], row: Row) {
  const scope = investigationScopeSchema.parse({
    workspaceId,
    serviceId: row.service_id,
    environmentId: row.environment_id,
    incidentId: row.incident_id,
  });
  return {
    scope,
    observedAt: row.observed_at.toISOString(),
    row:
      row.id === null
        ? null
        : {
            id: row.id,
            scope,
            state: row.state,
            attempts: row.attempt_count,
            createdAt: row.created_at?.toISOString(),
            updatedAt: row.updated_at?.toISOString(),
            leaseExpiresAt: row.lease_expires_at?.toISOString() ?? null,
            destination: row.destination,
            report: row.report,
            evidence: row.evidence,
          },
  };
}
/** Human report reads do not require machine runtime authority. The enabled responder and
 * incident join scopes the same snapshot that selects the report and redacted evidence. */
export class PostgresInvestigationReportRepository implements InvestigationReportRepository {
  constructor(private readonly pool: Pool) {}
  read(actor: Pick<Actor, "workspaceId" | "responderId">, incidentId: string) {
    opaqueIdSchema.parse(actor.responderId);
    opaqueIdSchema.parse(incidentId);
    return investigationTransaction(
      this.pool,
      actor.workspaceId,
      async (db) => {
        const result = await db.query<Row>(QUERY, [
          actor.workspaceId,
          actor.responderId,
          incidentId,
        ]);
        return result.rows[0]
          ? snapshot(actor.workspaceId, result.rows[0])
          : undefined;
      },
    );
  }
}
const QUERY = `WITH read_clock AS MATERIALIZED (SELECT clock_timestamp() AS observed_at),
visible_incident AS MATERIALIZED (
 SELECT i.id,i.service_id,i.environment_id
 FROM escalator_incident i
 JOIN escalator_responder r ON r.workspace_id=i.workspace_id AND r.id=$2
 WHERE i.workspace_id=$1 AND i.id=$3 AND r.enabled=true
)
SELECT incident.id AS incident_id,incident.service_id,incident.environment_id,
       read_clock.observed_at,
       run.id,run.state,run.attempt_count,run.created_at,run.updated_at,
       run.lease_expires_at,run.destination,run.report,run.evidence
FROM visible_incident incident CROSS JOIN read_clock
LEFT JOIN LATERAL (
 SELECT i.id,j.state,j.attempt_count,i.created_at,i.updated_at,j.lease_expires_at,
        i.configuration->'profile'->'destination' AS destination,i.report,
        COALESCE((SELECT jsonb_agg(snapshot.data ORDER BY snapshot.id)
          FROM (SELECT e.id,e.data FROM escalator_investigation_evidence e
                WHERE e.workspace_id=i.workspace_id AND e.investigation_id=i.id
                ORDER BY e.id LIMIT 129) snapshot),'[]'::jsonb) AS evidence
 FROM escalator_investigation i
 JOIN escalator_job j ON j.workspace_id=i.workspace_id AND j.id=i.id AND j.kind='investigation.run'
 WHERE i.workspace_id=$1 AND i.incident_id=incident.id
   AND i.service_id=incident.service_id AND i.environment_id=incident.environment_id
 ORDER BY i.created_at DESC,i.id DESC LIMIT 1
) run ON true`;
