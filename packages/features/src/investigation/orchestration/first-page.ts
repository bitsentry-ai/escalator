import {
  operationalIncidentSchema,
  investigationSettingsSchema,
  type OperationalIncident,
  type InvestigationSettings,
} from "../../contracts/index.js";
import { pagingWorkId } from "../../application/paging/work-ids.js";
import { investigationIntentSchema } from "./capture.js";
import type { InvestigationIntent } from "../ports/index.js";

/** Pure first-page snapshot. No credential redemption, network access or model execution. */
export function firstPageInvestigation(
  incidentInput: OperationalIncident,
  settingsInput: InvestigationSettings | undefined,
): InvestigationIntent | undefined {
  const incident = operationalIncidentSchema.parse(incidentInput);
  if (!settingsInput) return undefined;
  const settings = investigationSettingsSchema.parse(settingsInput);
  const scope = settings.profile.scope;
  if (
    scope.workspaceId !== incident.workspaceId ||
    scope.serviceId !== incident.serviceId ||
    scope.environmentId !== incident.environmentId
  )
    throw new Error("Investigation settings scope mismatch");
  if (!settings.enabled) return undefined;
  if (incident.resolvedAt !== null)
    throw new Error("Open incident required for investigation");
  const id = pagingWorkId(incident.workspaceId, "investigation", incident.id);
  const to = new Date(incident.openedAt).toISOString();
  return investigationIntentSchema.parse({
    id,
    idempotencyKey: id,
    scope: { ...scope, incidentId: incident.id },
    profileId: settings.profile.id,
    limits: settings.limits,
    sources: settings.sources.map(({ kind, sourceId, lookbackMs, limit }) => ({
      kind,
      sourceId,
      limit,
      window: { from: new Date(Date.parse(to) - lookbackMs).toISOString(), to },
    })),
  });
}
