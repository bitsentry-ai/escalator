import { z } from "zod";
import { evidenceKindSchema, opaqueIdSchema } from "../../contracts/index.js";
import { modelProfileSchema } from "../models/profiles.js";
import { investigationClaimSchema } from "./claims.js";
import type {
  InvestigationClaim,
  InvestigationIntent,
} from "../ports/index.js";
export const investigationIntentSchema = investigationClaimSchema
  .pick({ id: true, scope: true, profileId: true, limits: true, sources: true })
  .extend({ idempotencyKey: opaqueIdSchema });
/** Only opaque binding versions, never provider credentials, raw queries or response bodies. */
export const investigationConfigurationSchema = z.strictObject({
  profile: modelProfileSchema,
  secretIds: z.array(opaqueIdSchema).max(64),
  sourceVersions: z
    .array(
      z.strictObject({
        kind: evidenceKindSchema,
        sourceId: opaqueIdSchema,
        revision: opaqueIdSchema,
      }),
    )
    .max(32),
});
export type InvestigationConfiguration = z.infer<
  typeof investigationConfigurationSchema
>;
export interface CapturedInvestigation {
  intent: InvestigationIntent;
  configuration: InvestigationConfiguration;
}
/** Called with trusted host configuration before inserting an intent in the paging transaction. */
export function captureInvestigation(
  input: unknown,
  configurationInput: unknown,
): CapturedInvestigation {
  const intent = investigationIntentSchema.parse(input);
  const configuration =
    investigationConfigurationSchema.parse(configurationInput);
  const profile = configuration.profile;
  if (
    new Set(configuration.secretIds).size !== configuration.secretIds.length ||
    (profile.secretId !== null &&
      !configuration.secretIds.includes(profile.secretId))
  )
    throw new Error("Investigation secrets do not match approved bindings");
  if (
    profile.id !== intent.profileId ||
    profile.scope.workspaceId !== intent.scope.workspaceId ||
    profile.scope.serviceId !== intent.scope.serviceId ||
    profile.scope.environmentId !== intent.scope.environmentId
  )
    throw new Error("Investigation profile is not bound to its incident scope");
  const key = (value: { kind: string; sourceId: string }) =>
    `${value.kind}\0${value.sourceId}`;
  const required = new Set(intent.sources.map(key));
  const captured = new Set(configuration.sourceVersions.map(key));
  if (
    captured.size !== configuration.sourceVersions.length ||
    captured.size !== required.size ||
    [...required].some((id) => !captured.has(id))
  )
    throw new Error(
      "Investigation sources are missing captured binding versions",
    );
  if (Buffer.byteLength(JSON.stringify(configuration), "utf8") > 262144)
    throw new Error("Investigation configuration exceeds its byte limit");
  return { intent, configuration };
}
/** Lease expiry is checked with database time after locking; caller metadata is never authority. */
export function sameInvestigationClaim(
  input: InvestigationClaim,
  current: InvestigationClaim,
): boolean {
  const left = investigationClaimSchema.safeParse(input);
  const right = investigationClaimSchema.safeParse(current);
  if (!left.success || !right.success) return false;
  const normalize = (claim: InvestigationClaim) => ({
    ...claim,
    leaseExpiresAt: "",
  });
  return (
    JSON.stringify(normalize(left.data)) ===
    JSON.stringify(normalize(right.data))
  );
}
/** Live binding checks reject changes since enqueue, not just changes during model generation. */
export function sameInvestigationConfiguration(
  captured: InvestigationConfiguration,
  input: unknown,
): boolean {
  const left = investigationConfigurationSchema.safeParse(captured);
  const right = investigationConfigurationSchema.safeParse(input);
  if (!left.success || !right.success) return false;
  const normalize = (value: InvestigationConfiguration) => ({
    ...value,
    secretIds: [...value.secretIds].sort(),
    sourceVersions: [...value.sourceVersions].sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) || a.sourceId.localeCompare(b.sourceId),
    ),
  });
  return (
    JSON.stringify(normalize(left.data)) ===
    JSON.stringify(normalize(right.data))
  );
}
