import { z } from "zod";
import {
  opaqueIdSchema,
  serviceIdSchema,
  environmentIdSchema,
} from "./identity.js";
import { environmentSchema } from "./entities.js";
import { operationalIncidentSchema } from "./paging.js";
export const incidentPageInputSchema = z.strictObject({
  limit: z.number().int().min(1).max(50).default(25),
  after: opaqueIdSchema.optional(),
});
/** Incident list cursors carry the sort key (open state, opened time, ID). */
export const incidentListInputSchema = incidentPageInputSchema.extend({
  after: z
    .string()
    .max(160)
    .regex(/^[or]\.\d{1,15}\.[A-Za-z0-9][A-Za-z0-9._:-]*$/)
    .optional(),
});
export const manualIncidentInputSchema = z.strictObject({
  requestId: opaqueIdSchema,
  serviceId: serviceIdSchema,
  environmentId: environmentIdSchema,
  policyId: opaqueIdSchema,
  title: operationalIncidentSchema.shape.title,
  severity: operationalIncidentSchema.shape.severity,
});
export const createEnvironmentInputSchema = z.strictObject({
  name: environmentSchema.shape.name,
  key: environmentSchema.shape.key,
  isProduction: z.boolean(),
});
export const incidentDetailInputSchema = z.strictObject({ id: opaqueIdSchema });
export const incidentDeliveriesInputSchema = z.strictObject({
  incidentId: opaqueIdSchema,
  limit: z.number().int().min(1).max(25).default(10),
  after: opaqueIdSchema.optional(),
});
export const deliveryAttemptsInputSchema = incidentDeliveriesInputSchema.extend(
  { deliveryId: opaqueIdSchema },
);
export type IncidentPageInput = z.input<typeof incidentPageInputSchema>;
export type IncidentListInput = z.input<typeof incidentListInputSchema>;
export type IncidentDeliveriesInput = z.input<
  typeof incidentDeliveriesInputSchema
>;
export type DeliveryAttemptsInput = z.input<typeof deliveryAttemptsInputSchema>;
export type ManualIncidentInput = z.infer<typeof manualIncidentInputSchema>;
export type CreateEnvironmentInput = z.infer<
  typeof createEnvironmentInputSchema
>;

export interface IncidentDetail {
  incident: import("./paging.js").OperationalIncident;
  pageId: string;
  state: import("./paging.js").OperationalPage["state"];
  revision: number;
  policyId: string;
  policyVersion: number;
  owner: { id: string; displayName: string } | null;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  timeline: {
    id: string;
    recordId: string | null;
    target: import("./escalation.js").EscalationStep["target"];
    dueAt: string;
    recordedAt: string | null;
    disposition: "pending" | "dispatch" | "skipped" | "uncovered";
    recipientCount: number;
  }[];
}
export type IncidentAttempt = Pick<
  import("./paging.js").DeliveryAttempt,
  | "id"
  | "attempt"
  | "startedAt"
  | "finishedAt"
  | "outcome"
  | "completedAfterAcknowledgement"
  | "retryable"
  | "failureReason"
>;
export interface IncidentDelivery {
  id: string;
  stepId: string;
  recipient: { id: string; displayName: string };
  channel: import("./paging.js").RecipientDelivery["channel"];
  createdAt: string;
  attempts: { items: IncidentAttempt[]; next: string | null };
}
