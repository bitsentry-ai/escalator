import { z } from "zod";
import { opaqueIdSchema } from "./identity.js";
import { signalSourceSchema } from "./signal.js";
import {
  providerIntakeSchema,
  usesProviderSignature,
} from "./intake-config.js";
const fields = signalSourceSchema.shape;
const credentials = {
  intake: providerIntakeSchema,
  authSecretId: opaqueIdSchema.nullable(),
};
function signatureBinding(
  value: z.infer<typeof providerIntakeSchema>,
  secret: string | null,
) {
  return usesProviderSignature(value) === (secret !== null);
}
export const createProviderSourceSchema = z
  .strictObject({
    name: fields.name,
    serviceId: fields.serviceId,
    environmentId: fields.environmentId,
    grouping: fields.grouping.default("source-fingerprint"),
    recoveryHoldSeconds: fields.recoveryHoldSeconds.default(60),
    ...credentials,
  })
  .refine(
    (value) => signatureBinding(value.intake, value.authSecretId),
    "Signed sources require an opaque secret ID; token sources do not use one",
  );
export const updateProviderSourceSchema = z
  .strictObject({
    id: opaqueIdSchema,
    expectedVersion: fields.version,
    ...credentials,
  })
  .refine(
    (value) => signatureBinding(value.intake, value.authSecretId),
    "Invalid source secret binding",
  );
export type CreateProviderSourceInput = z.input<
  typeof createProviderSourceSchema
>;
export type UpdateProviderSourceInput = z.input<
  typeof updateProviderSourceSchema
>;
