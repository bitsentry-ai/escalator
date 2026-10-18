import { z } from "zod";

// Host IDs remain opaque: standalone UUIDs and WorkOS org IDs use the same port.
const opaqueId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const workspaceIdSchema = opaqueId.brand<"WorkspaceId">();
export const serviceIdSchema = opaqueId.brand<"ServiceId">();
export const environmentIdSchema = opaqueId.brand<"EnvironmentId">();
export const responderIdSchema = opaqueId.brand<"ResponderId">();
export type WorkspaceId = z.infer<typeof workspaceIdSchema>;
export type ServiceId = z.infer<typeof serviceIdSchema>;
export type EnvironmentId = z.infer<typeof environmentIdSchema>;
export type ResponderId = z.infer<typeof responderIdSchema>;

export const roleSchema = z.enum(["administrator", "responder", "viewer"]);
export type Role = z.infer<typeof roleSchema>;
export const capabilities = [
  "service:read",
  "service:manage",
  "schedule:read",
  "schedule:manage",
  "incident:read",
  "incident:acknowledge",
  "incident:resolve",
  "deployment:read",
  "deployment:override",
  "rule:read",
  "rule:propose",
  "rule:approve",
  "workspace:manage",
  "secret:manage",
  "audit:read",
] as const;
export const capabilitySchema = z.enum(capabilities);
export type Capability = z.infer<typeof capabilitySchema>;
const viewerCapabilities: readonly Capability[] = [
  "service:read",
  "schedule:read",
  "incident:read",
  "deployment:read",
  "rule:read",
];
const roleCapabilities: Readonly<Record<Role, readonly Capability[]>> = {
  administrator: capabilities,
  responder: [
    ...viewerCapabilities,
    "incident:acknowledge",
    "incident:resolve",
    "rule:propose",
  ],
  viewer: viewerCapabilities,
};
export function hasCapability(role: Role, capability: Capability): boolean {
  return roleCapabilities[role].includes(capability);
}

/** Constructed by a host from trusted authentication, never request-body scope. */
export interface Actor {
  workspaceId: WorkspaceId;
  responderId: ResponderId;
  role: Role;
}
